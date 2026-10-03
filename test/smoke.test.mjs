/**
 * 手动冒烟测试：走真实的 Node 代码路径（buildProbeCommand → runRemote → parseProbeOutput），
 * 打到本机 WSL 发行版上。不依赖 DSH 运行时。
 *
 *   node test/smoke.mjs [distro]
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { normalizeConfig } from '../lib/config.js'
import { RemoteManager } from '../lib/manager.js'
import { buildProbeCommand, parseProbeOutput } from '../lib/probe.js'
import { remoteExec } from '../lib/remote-ops.js'
import { runRemote, probeConnectivity } from '../lib/ssh.js'
import { listRemoteDirectory, readRemoteFile } from '../lib/ops.js'

const distro = process.argv[2] || 'Ubuntu-24.04'

const { config, errors } = normalizeConfig({
  targets: [
    { kind: 'wsl', name: `WSL ${distro}`, distro, channel: 'wsl', user: 'root', tags: ['local'] },
  ],
  timeoutMs: 120_000,
  probeIntervalMs: 60_000,
  historyLength: 5,
})

if (errors.length) {
  console.error('config errors:', errors)
  process.exit(1)
}

const target = config.targets[0]
console.log(`target: ${target.id} kind=${target.kind} channel=${target.channel} distro=${target.distro}`)

console.log('\n--- connectivity ---')
const conn = await probeConnectivity(target, config, { timeoutMs: 120_000 })
console.log(conn)

console.log('\n--- full probe ---')
const startedAt = Date.now()
const result = await runRemote(target, config, buildProbeCommand(), { timeoutMs: 120_000 })
console.log(`ok=${result.ok} channel=${result.channel} code=${result.code} ms=${Date.now() - startedAt}`)
if (!result.ok) {
  console.error('error:', result.error)
  console.error('stderr:', result.stderr.slice(0, 500))
}

const parsed = parseProbeOutput(result.stdout, result.stderr, {
  collectDocker: true,
  collectProcesses: true,
  collectServices: true,
  collectGpu: true,
})

console.log('\n--- facts ---')
console.log(JSON.stringify(parsed.facts, null, 2))
console.log('\n--- metrics ---')
console.log(JSON.stringify(parsed.metrics, null, 2))
console.log('\n--- warnings ---', parsed.warnings)
console.log('complete:', parsed.complete)

// 只读的运维操作也顺带真跑一遍：这两条路径（列目录、按上限读文件）没法离线单测，
// 而它们的解析逻辑恰恰是修过 bug 的地方。
console.log('\n--- ops (read-only) ---')
let readResult = { truncated: undefined, totalBytes: 0, content: '' }
let listing = { entries: [], truncated: undefined }
let opsError = ''
try {
  readResult = await readRemoteFile(target, config, '/proc/version', 10)
  listing = await listRemoteDirectory(target, config, '/etc')
  console.log(`read /proc/version (limit 10): totalBytes=${readResult.totalBytes} truncated=${readResult.truncated}`)
  console.log(`list /etc: ${listing.entries.length} entries truncated=${listing.truncated}`)
} catch (error) {
  opsError = String(error?.message || error)
  console.error('ops check failed:', opsError)
}

// 目标级超时必须真的传到传输层 —— 不只是配置里躺着。
// 同一台机器：全局 120s，但该目标写了 3000ms，于是 `sleep 6` 必须被判超时。
console.log('\n--- target-level timeout (3000ms) vs a 6s command ---')
let execTimeout = { ok: false, summary: '' }
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wsx-smoke-'))
const tightManager = new RemoteManager({
  rawConfig: {
    stateFile: path.join(stateDir, 'state.json'),
    targets: [{ kind: 'wsl', name: `WSL ${distro}`, distro, channel: 'wsl', user: 'root', timeoutMs: 3000 }],
    timeoutMs: 120_000,
    probeOnStart: false,
  },
  pluginVersion: 'smoke',
  logger: { warn: () => {}, debug: () => {} },
})
try {
  const tightTarget = tightManager.runtimes[0].target
  const startedAt = Date.now()
  execTimeout = await remoteExec(tightManager, { target: tightTarget.id, command: 'sleep 6' })
  console.log(`remoteExec sleep 6 → ok=${execTimeout.ok} in ${Date.now() - startedAt}ms`)
  console.log(`summary: ${execTimeout.summary.split('\n')[0]}`)
} catch (error) {
  console.error('target timeout check failed:', error)
} finally {
  tightManager.dispose()
  fs.rmSync(stateDir, { recursive: true, force: true })
}

// 断言几条必须成立的事实，让这个脚本能当回归测试用。
const checks = [
  ['facts.hostname present', Boolean(parsed.facts.hostname)],
  ['facts.os present', Boolean(parsed.facts.os)],
  ['facts.wsl true', parsed.facts.wsl === true],
  ['facts.cpuCount is an integer', Number.isInteger(parsed.facts.cpuCount)],
  ['facts.cpuModel present', Boolean(parsed.facts.cpuModel)],
  ['cpu.usagePercent is 0..100', parsed.metrics.cpu?.usagePercent >= 0 && parsed.metrics.cpu?.usagePercent <= 100],
  ['load1 is a number', typeof parsed.metrics.cpu?.load1 === 'number'],
  ['memory.totalBytes > 0', parsed.metrics.memory?.totalBytes > 0],
  ['memory.usagePercent is 0..100', parsed.metrics.memory?.usagePercent >= 0 && parsed.metrics.memory?.usagePercent <= 100],
  ['at least one disk', (parsed.metrics.disks?.length ?? 0) > 0],
  ['root disk has usagePercent', parsed.metrics.disks?.some((d) => d.mount === '/' && typeof d.usagePercent === 'number')],
  ['processes.topCpu non-empty', (parsed.metrics.processes?.topCpu?.length ?? 0) > 0],
  ['docker.available is boolean', typeof parsed.metrics.docker?.available === 'boolean'],
  ['services non-empty', (parsed.metrics.services?.length ?? 0) > 0],
  ['complete true', parsed.complete === true],
  ['no warnings', parsed.warnings.length === 0],
  ['readRemoteFile honoured the byte limit', readResult.content.length <= 10],
  ['readRemoteFile reported the real size', (readResult.totalBytes ?? 0) > 10],
  ['readRemoteFile reported truncation', readResult.truncated === true],
  ['listRemoteDirectory parsed entries', listing.entries.length > 0],
  ['listRemoteDirectory found a subdirectory', listing.entries.some((e) => e.type === 'dir')],
  ['listRemoteDirectory reported no truncation for /etc', listing.truncated === false],
  ['ops ran without error', opsError === ''],
  [
    'target-level timeoutMs reached the transport',
    execTimeout.ok === false && /timed out after 3s/.test(execTimeout.summary),
  ],
  ['a timed-out exec result still explains itself', /timed out after 3s/.test(JSON.stringify(execTimeout.data ?? {}))],
  [
    'a timed-out exec result is lossless JSON',
    JSON.stringify(execTimeout) === JSON.stringify(JSON.parse(JSON.stringify(execTimeout))),
  ],
]

console.log('\n--- checks ---')
let failed = 0
for (const [label, ok] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`)
  if (!ok) failed += 1
}
console.log(`\n${checks.length - failed}/${checks.length} passed`)
process.exit(failed ? 1 : 0)
