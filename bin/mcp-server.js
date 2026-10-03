#!/usr/bin/env node
/**
 * dsh-remote-panel —— MCP stdio 服务器
 * ============================================================================
 * 把本插件的 `remote_*` 能力通过 **Model Context Protocol** 暴露出去，
 * 这样任何 MCP 客户端（不只是 DSH）都能用同一套目标清单与安全闸门。
 *
 * 为什么自己实现而不是用官方 SDK：
 *   DSH 只 vendored 了 `@modelcontextprotocol/{client,core}`，**没有 server 包**；
 *   而这个插件要保持零依赖（不引入 npm 依赖、不需要构建步骤）。
 *   MCP 的 stdio 传输本身很简单 —— 一行一条 JSON-RPC 2.0，所以直接实现，
 *   反而比引一个 SDK 更可控。
 *
 * 传输：**换行分隔的 JSON（JSONL）**。这也是 MCP 规范里 stdio 的写法。
 *       stdout 只允许出现协议消息；一切日志走 stderr。
 *
 * 配置来源（按优先级）：
 *   1. `DSH_WSX_CONFIG` 环境变量 —— 直接是 JSON 字符串（便于临时覆盖）；
 *   2. `DSH_WSX_CONFIG_FILE` 环境变量 —— 指向 JSON 文件；
 *   3. `<DSH_HOME>/remote-panel/config.resolved.json` —— 宿主插件写出的那份。
 *
 * 安全：本进程**只读状态文件、不写它**（`writeState: false`），避免与宿主争抢心跳。
 *       写操作（docker/service/process kill）依然受 `allowMutations` 与
 *       `confirm: true` 两道闸门约束，与 DSH 侧完全一致。
 */

import fs from 'node:fs'
import process from 'node:process'
import { RemoteManager, resolvedConfigPath } from '../lib/manager.js'
import { TOOL_SPECS, projectParameters } from '../lib/tools.js'
import { resolveStateFile } from '../lib/config.js'
import { flatten } from '../lib/util.js'

const SERVER_NAME = 'dsh-remote-panel'
const SERVER_VERSION = '0.1.1'
const PROTOCOL_VERSION = '2024-11-05'
/** 我们真的实现了的协议版本。initialize 只在客户端要求的版本属于这个集合时回它。 */
const SUPPORTED_PROTOCOL_VERSIONS = new Set(['2024-11-05', '2024-10-07'])
/**
 * 单行 JSON-RPC 消息的上限。
 *
 * stdin 是按行缓冲的，一个坏客户端只要一直发不带换行的字节，`buffer` 就会
 * 无上限地长下去。超过上限就丢掉这一段并继续（协议里一条消息不可能有 8MB）。
 */
const MAX_LINE_BYTES = 8 * 1024 * 1024

/** 一切诊断都走 stderr —— stdout 是协议通道，多一个字节都会破坏会话。 */
function log(message) {
  try {
    process.stderr.write(`[dsh-remote-panel mcp] ${message}\n`)
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// 配置装载
// ---------------------------------------------------------------------------

function loadResolvedConfig() {
  const inline = process.env.DSH_WSX_CONFIG
  if (inline && inline.trim()) {
    try {
      const parsed = JSON.parse(inline)
      return { config: parsed?.config ?? parsed, source: 'DSH_WSX_CONFIG' }
    } catch (error) {
      log(`DSH_WSX_CONFIG is not valid JSON: ${error?.message ?? error}`)
    }
  }

  const explicit = process.env.DSH_WSX_CONFIG_FILE
  const stateFile = resolveStateFile({})
  const candidates = []
  if (explicit) candidates.push(explicit)
  candidates.push(resolvedConfigPath(stateFile))

  for (const candidate of candidates) {
    try {
      if (!fs.existsSync(candidate)) continue
      const parsed = JSON.parse(fs.readFileSync(candidate, 'utf8'))
      return { config: parsed?.config ?? parsed, source: candidate }
    } catch (error) {
      log(`cannot use config file ${candidate}: ${error?.message ?? error}`)
    }
  }

  return { config: {}, source: '(defaults — no targets configured)' }
}

const loaded = loadResolvedConfig()

const manager = new RemoteManager({
  rawConfig: loaded.config,
  pluginVersion: SERVER_VERSION,
  logger: { warn: log, debug: log },
  writeState: false,
})

log(`config source: ${loaded.source}`)
log(`state file: ${manager.config.stateFile}`)
log(`targets: ${manager.runtimes.map((r) => r.id).join(', ') || '(none)'}`)
if (manager.configErrors.length) log(`config problems: ${manager.configErrors.join(' | ')}`)

// ---------------------------------------------------------------------------
// 工具表
// ---------------------------------------------------------------------------

/** MCP 的 tools/list 条目：标准 JSON Schema，不能带我们内部的方言。 */
const MCP_TOOLS = TOOL_SPECS.map((spec) => ({
  name: spec.name,
  description: spec.description,
  inputSchema: projectParameters(spec.parameters),
}))

const SPEC_BY_NAME = new Map(TOOL_SPECS.map((spec) => [spec.name, spec]))

/** MCP 的 text content 结果。 */
function textResult(text, isError = false) {
  return { content: [{ type: 'text', text }], isError }
}

/** 把 `{ ok, summary, data }` 渲染成 MCP 的 content 数组。 */
function toMcpResult(result) {
  const blocks = []
  blocks.push({ type: 'text', text: result?.ok === false ? `FAILED: ${result.summary}` : String(result?.summary ?? '') })
  if (result?.data !== undefined && result?.data !== null) {
    blocks.push({ type: 'text', text: `\`\`\`json\n${JSON.stringify(result.data, null, 2)}\n\`\`\`` })
  }
  return { content: blocks, isError: result?.ok === false }
}

async function callTool(name, args) {
  const spec = SPEC_BY_NAME.get(name)
  if (!spec) {
    return textResult(`Unknown tool ${JSON.stringify(name)}. Available: ${[...SPEC_BY_NAME.keys()].join(', ')}`, true)
  }
  try {
    const result = await spec.run(manager, args ?? {}, {
      // MCP 进程没有面板 launcher；remote_panel 只回报状态文件信息。
      panelExe: () => null,
    })
    return toMcpResult(result)
  } catch (error) {
    // 实现层本来就不该抛异常，这里是最后一道兜底。
    return textResult(`Tool ${name} failed: ${flatten(error?.message || error, 500)}`, true)
  }
}

// ---------------------------------------------------------------------------
// JSON-RPC / MCP 协议
// ---------------------------------------------------------------------------

function send(message) {
  try {
    process.stdout.write(`${JSON.stringify(message)}\n`)
  } catch (error) {
    log(`cannot write to stdout: ${error?.message ?? error}`)
  }
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result })
}

function replyError(id, code, message, data) {
  send({ jsonrpc: '2.0', id, error: { code, message, ...(data === undefined ? {} : { data }) } })
}

async function handleRequest(message) {
  const { id, method, params } = message

  // 通知（没有 id）不需要回复。
  if (id === undefined || id === null) {
    if (method === 'notifications/initialized' || method === 'initialized') {
      log('client initialised')
    }
    return
  }

  switch (method) {
    case 'initialize': {
      const requested = params?.protocolVersion
      // 必须回一个**我们支持的**版本：以前这里直接把客户端要的版本原样回显，
      // 于是客户端要 "9999-01-01" 也会被「确认」，双方对协议的理解从此不一致
      // （注释写的是「回一个我们确定支持的版本」，代码却做的是回显）。
      const agreed =
        typeof requested === 'string' && SUPPORTED_PROTOCOL_VERSIONS.has(requested) ? requested : PROTOCOL_VERSION
      return reply(id, {
        protocolVersion: agreed,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        instructions:
          'Read-only status preview plus docker/service/process/file operations for local WSL distributions and remote SSH machines. ' +
          'Call remote_status first to discover target ids.',
      })
    }

    case 'ping':
      return reply(id, {})

    case 'tools/list':
      return reply(id, { tools: MCP_TOOLS })

    case 'tools/call': {
      const name = params?.name
      const args = params?.arguments ?? {}
      const result = await callTool(name, args)
      return reply(id, result)
    }

    case 'resources/list':
      return reply(id, { resources: [] })

    case 'prompts/list':
      return reply(id, { prompts: [] })

    default:
      return replyError(id, -32601, `Method not found: ${method}`)
  }
}

/** 逐行读 stdin，按 JSONL 解析。 */
let buffer = ''
let chain = Promise.resolve()
/**
 * 处于「正在丢弃一段超长垃圾」的状态。
 *
 * 只把 buffer 清空是不够的：那段垃圾的**剩余字节**还会继续到达，
 * 会被拼到下一段合法消息前面，于是真正的那条请求变成解析错误。
 * 所以要一直丢到下一个换行为止（协议里一条消息就是一行）。
 */
let skippingOversizedLine = false

process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  if (skippingOversizedLine) {
    const newline = chunk.indexOf('\n')
    if (newline < 0) return
    skippingOversizedLine = false
    chunk = chunk.slice(newline + 1)
  }
  buffer += chunk
  if (buffer.indexOf('\n') < 0 && buffer.length > MAX_LINE_BYTES) {
    // 一整段都没有换行 = 不是合法的 JSONL 消息。丢掉它并重新同步，保住内存。
    log(`dropped ${buffer.length} bytes with no newline (over the ${MAX_LINE_BYTES}-byte line limit); resyncing at the next newline`)
    buffer = ''
    skippingOversizedLine = true
    return
  }
  let index
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index).trim()
    buffer = buffer.slice(index + 1)
    if (!line) continue

    let message
    try {
      message = JSON.parse(line)
    } catch (error) {
      // 解析失败没法回 id，只能报一个 null-id 的错误。
      replyError(null, -32700, `Parse error: ${error?.message ?? error}`)
      continue
    }

    // 串行处理：工具调用可能碰同一个目标，并发跑会让输出顺序与日志难以对应。
    chain = chain
      .then(() => handleRequest(message))
      .catch((error) => log(`handler failed: ${flatten(error?.message || error, 300)}`))
  }
})

process.stdin.on('end', () => {
  log('stdin closed — shutting down')
  manager.dispose()
  process.exit(0)
})

process.on('SIGINT', () => {
  manager.dispose()
  process.exit(0)
})
process.on('SIGTERM', () => {
  manager.dispose()
  process.exit(0)
})

// 启动时就探一轮，这样客户端第一次 remote_status 就能拿到真实数据，
// 而不是一片 unknown。探测是异步的，不阻塞协议握手。
manager
  .probeAll()
  .then(() => log('initial probe complete'))
  .catch((error) => log(`initial probe failed: ${flatten(error?.message || error, 300)}`))

log('ready')
