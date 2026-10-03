/**
 * MCP 服务器的协议级冒烟测试。
 *
 * 用 JSONL 把 initialize / tools/list / tools/call 喂给 `bin/mcp-server.js`，
 * 检查它按 MCP 约定应答。不依赖任何 MCP SDK —— 手写请求反而更能暴露协议错误。
 *
 *   node test/mcp.test.mjs [distro]
 */

import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SERVER = path.resolve(HERE, '..', 'bin', 'mcp-server.js')
const distro = process.argv[2] || 'Ubuntu-24.04'

// 用内联配置，避免依赖宿主插件先跑起来。
const inlineConfig = {
  config: {
    targets: [{ kind: 'wsl', name: `WSL ${distro}`, distro, channel: 'wsl', user: 'root', tags: ['local'] }],
    timeoutMs: 120_000,
    probeOnStart: true,
    historyLength: 5,
  },
}

const child = spawn(process.execPath, [SERVER], {
  env: { ...process.env, WSL_UTF8: '1', DSH_WSX_CONFIG: JSON.stringify(inlineConfig) },
  stdio: ['pipe', 'pipe', 'pipe'],
})

let stdout = ''
let stderr = ''
child.stdout.setEncoding('utf8')
child.stderr.setEncoding('utf8')
child.stdout.on('data', (c) => {
  stdout += c
})
child.stderr.on('data', (c) => {
  stderr += c
})

const requests = [
  { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } } },
  { jsonrpc: '2.0', method: 'notifications/initialized' },
  { jsonrpc: '2.0', id: 2, method: 'tools/list' },
  { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'remote_status', arguments: { refresh: true } } },
  { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'remote_exec', arguments: { target: distro.toLowerCase(), command: 'uname -r; nproc' } } },
  { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'no_such_tool', arguments: {} } },
  { jsonrpc: '2.0', id: 6, method: 'bogus/method' },
  // 客户端要求一个我们根本不支持的协议版本：必须回一个**我们支持的**版本，
  // 而不是把它原样回显（回显等于假装已经达成一致）。
  { jsonrpc: '2.0', id: 7, method: 'initialize', params: { protocolVersion: '9999-01-01' } },
  // 一个不存在的目标：必须是 isError 的结果，而不是把 JSON-RPC 连接打崩。
  { jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'remote_status', arguments: { target: 'definitely-not-a-target' } } },
  { jsonrpc: '2.0', id: 9, method: 'ping' },
]

// 先灌一段 9MB、没有换行的垃圾：服务器必须丢掉它并重新同步，
// 后面这些合法请求仍然要一条不落地被处理（这条同时守着「stdin 缓冲不会无上限增长」）。
child.stdin.write('x'.repeat(9 * 1024 * 1024))
child.stdin.write('\n')

for (const request of requests) {
  child.stdin.write(`${JSON.stringify(request)}\n`)
}

/** 等到指定 id 的应答都出现了（或超时）。 */
async function waitForIds(ids, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const seen = new Set()
    for (const line of stdout.split('\n')) {
      if (!line.trim()) continue
      try {
        const message = JSON.parse(line)
        if (message.id !== undefined && message.id !== null) seen.add(message.id)
      } catch {
        /* 半行，等下一轮 */
      }
    }
    if (ids.every((id) => seen.has(id))) return true
    await new Promise((r) => setTimeout(r, 250))
  }
  return false
}

const ok = await waitForIds([1, 2, 3, 4, 5, 6, 7, 8, 9])
child.stdin.end()
await new Promise((r) => setTimeout(r, 500))
try {
  child.kill()
} catch {
  /* ignore */
}

const responses = new Map()
const parseErrors = []
for (const line of stdout.split('\n')) {
  if (!line.trim()) continue
  try {
    const message = JSON.parse(line)
    if (message.id !== undefined && message.id !== null) responses.set(message.id, message)
  } catch {
    parseErrors.push(line.slice(0, 200))
  }
}

const checks = []
const check = (label, condition) => checks.push([label, Boolean(condition)])

check('all responses received', ok)
check('no unparseable stdout lines', parseErrors.length === 0)

const init = responses.get(1)?.result
check('initialize returns serverInfo.name', init?.serverInfo?.name === 'dsh-remote-panel')
check('initialize returns protocolVersion', typeof init?.protocolVersion === 'string')
check('initialize advertises tools capability', Boolean(init?.capabilities?.tools))

const tools = responses.get(2)?.result?.tools
check('tools/list returns 7 tools', tools?.length === 7)
check('every tool has an object inputSchema', (tools ?? []).every((t) => t.inputSchema?.type === 'object'))
check(
  'no defineTool dialect leaked into MCP schemas',
  (tools ?? []).every((t) => Object.values(t.inputSchema?.properties ?? {}).every((p) => p && typeof p === 'object' && !('required' in p))),
)
check(
  'remote_exec requires target and command',
  JSON.stringify(tools?.find((t) => t.name === 'remote_exec')?.inputSchema?.required?.slice().sort()) === JSON.stringify(['command', 'target']),
)
check(
  'remote_services.services is typed as array',
  tools?.find((t) => t.name === 'remote_services')?.inputSchema?.properties?.services?.type === 'array',
)

const status = responses.get(3)?.result
check('remote_status returns content', Array.isArray(status?.content) && status.content.length > 0)
check('remote_status is not an error', status?.isError !== true)
check('remote_status reported a target', /WSL Ubuntu-24.04/.test(status?.content?.[0]?.text ?? ''))
check('remote_status found the host online', /online/.test(status?.content?.[0]?.text ?? ''))

const execd = responses.get(4)?.result
check('remote_exec returns content', Array.isArray(execd?.content))
check('remote_exec captured kernel string', /microsoft-standard-WSL2/.test(JSON.stringify(execd?.content ?? '')))

const unknown = responses.get(5)?.result
check('unknown tool is reported as an MCP error', unknown?.isError === true)
check('unknown tool message lists availability', /Unknown tool/.test(unknown?.content?.[0]?.text ?? ''))

check('unknown method returns -32601', responses.get(6)?.error?.code === -32601)

const bogusVersion = responses.get(7)?.result
check(
  'initialize never agrees to a protocol version we do not support',
  bogusVersion?.protocolVersion === '2024-11-05',
)

const missingTarget = responses.get(8)?.result
check('a failed tool call is an MCP error result', missingTarget?.isError === true)
check(
  'a failed tool call names the available targets',
  /no target matching/.test(missingTarget?.content?.[0]?.text ?? ''),
)
check('the connection survives a 9MB line of garbage', responses.get(9)?.result !== undefined)
check('oversized input produced no parse errors', !/Parse error/.test(stderr))

console.log('--- stderr (server log) ---')
console.log(stderr.trim().split('\n').slice(-12).join('\n'))
console.log('\n--- checks ---')
let failed = 0
for (const [label, passed] of checks) {
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${label}`)
  if (!passed) failed += 1
}
console.log(`\n${checks.length - failed}/${checks.length} passed`)
if (failed) {
  console.log('\n--- raw responses ---')
  for (const [id, message] of responses) console.log(id, JSON.stringify(message).slice(0, 400))
}
process.exit(failed ? 1 : 0)
