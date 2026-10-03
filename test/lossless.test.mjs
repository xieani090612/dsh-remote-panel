/**
 * 回归测试：`remote_*` 工具的返回值必须是**无损 JSON**。
 *
 * 背景（这是一个真实踩过的坑）：
 *   `TargetRuntime.toJSON()` 会为缺失字段显式产出 `undefined`。写状态文件时这无害
 *   （`JSON.stringify` 会把它们丢掉），但工具的**返回值**要过 DSH 的 lossless-JSON
 *   校验 —— 一个 `undefined` 属性就让整个调用失败，而且报错只有一句
 *   「value is not lossless JSON」，不指明字段，定位成本极高。
 *
 * 所以这里用一个**目标故意带一堆 optional 字段为空**的 manager 去调工具，
 * 确认输出仍然能无损 round-trip。上游任何人再往 toJSON 里加 optional 字段，
 * 这个测试都会兜住。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { remotePanel, remoteStatus } from '../lib/remote-ops.js'

/** 递归找出所有不能被 JSON 无损表示的位置。 */
function findLossy(value, path = '$', seen = new Set()) {
  const problems = []
  const type = typeof value
  if (type === 'function') return [`${path}: function`]
  if (type === 'undefined') return [`${path}: undefined`]
  if (type === 'number' && !Number.isFinite(value)) return [`${path}: ${value}`]
  if (type === 'bigint' || type === 'symbol') return [`${path}: ${type}`]
  if (value === null || type !== 'object') return problems
  if (seen.has(value)) return [`${path}: circular`]
  seen.add(value)
  if (Array.isArray(value)) {
    value.forEach((item, index) => problems.push(...findLossy(item, `${path}[${index}]`, seen)))
  } else {
    for (const [key, item] of Object.entries(value)) {
      problems.push(...findLossy(item, `${path}.${key}`, seen))
    }
  }
  seen.delete(value)
  return problems
}

/**
 * 一个最小的假 manager：`snapshot()` 直接给出一份「各种字段都缺」的快照，
 * 形状与真实 `TargetRuntime.toJSON()` 完全一致（含显式 undefined）。
 */
function makeManager({ secondTarget = false } = {}) {
  const runtime = {
    id: 'wsl-ubuntu-2404',
    target: { id: 'wsl-ubuntu-2404', name: 'WSL Ubuntu 24.04', kind: 'wsl', distro: 'Ubuntu-24.04' },
    status: 'online',
    toJSON: () => ({
      id: 'wsl-ubuntu-2404',
      name: 'WSL Ubuntu 24.04',
      kind: 'wsl',
      host: '127.0.0.1',
      user: 'root',
      port: undefined, // 缺失的可选字段
      tags: [],
      enabled: true,
      status: 'online',
      error: undefined,
      latencyMs: undefined,
      lastProbeAt: 1_700_000_000_000,
      lastOnlineAt: undefined,
      nextProbeAt: undefined,
      staleMs: undefined,
      consecutiveFailures: 0,
      woke: undefined,
      warnings: undefined,
      facts: {
        hostname: 'h',
        wsl: true,
        // 这两个是「面板在读、以前被丢掉」的字段：它们也要能无损过一遍。
        cpuModel: 'Intel(R) Core(TM) i5-8200Y CPU @ 1.30GHz',
        cpuCount: 2,
        uptimeSec: 88,
        arch: undefined,
      },
      metrics: {
        cpu: { usagePercent: undefined, load1: 0.5, load5: undefined, load15: undefined },
        memory: { totalBytes: 1024, usedBytes: undefined, usagePercent: undefined },
        disks: [],
        gpus: [],
        docker: null,
        processes: undefined,
        services: undefined,
      },
      history: [],
      diskCritical: undefined,
      cpuCount: 2,
    }),
    pushHistory() {},
  }

  const second = {
    id: 'ssh-prod-backup',
    target: { id: 'ssh-prod-backup', name: 'prod-backup', kind: 'ssh', host: '10.0.0.2' },
    status: 'offline',
    toJSON: () => ({
      id: 'ssh-prod-backup',
      name: 'prod-backup',
      kind: 'ssh',
      host: '10.0.0.2',
      status: 'offline',
      error: undefined,
      metrics: null,
      history: [],
      diskCritical: undefined,
      cpuCount: undefined,
    }),
  }

  const runtimes = secondTarget ? [runtime, second] : [runtime]

  const snapshot = () => ({
    schema: 1,
    generatedAt: 1_700_000_000_000,
    host: { pid: 1, pluginVersion: 'test', stateFile: 'X:\\state.json', configErrors: undefined },
    totals: { targets: runtimes.length, online: 1, offline: runtimes.length - 1, probing: 0, unknown: 0, dockerRunning: 0 },
    targets: runtimes.map((r) => r.toJSON()),
    errors: [],
  })

  return {
    config: { stateFile: 'X:\\state.json', timeoutMs: 1000 },
    runtimes,
    getTarget: (selector) => (String(selector).toLowerCase().includes('ubuntu') ? runtime.target : undefined),
    runtimeFor: () => runtime,
    snapshot,
    wake: async () => [runtime],
  }
}

test('remote_status returns lossless JSON even when optional fields are absent', async () => {
  const result = await remoteStatus(makeManager(), {})
  assert.equal(result.ok, true)
  assert.deepEqual(findLossy(result), [], 'a single undefined property would fail DSH tool validation')
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result)
})

test('remote_status (refresh) returns lossless JSON', async () => {
  const result = await remoteStatus(makeManager(), { refresh: true })
  assert.deepEqual(findLossy(result), [])
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result)
})

test('remote_panel status returns lossless JSON', async () => {
  const result = await remotePanel(makeManager(), { action: 'status' }, { panelExe: () => '' })
  assert.equal(result.ok, true)
  assert.deepEqual(findLossy(result), [])
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result)
})

test('remote_panel reports a missing launcher as a clean failure', async () => {
  const result = await remotePanel(makeManager(), { action: 'open' }, {})
  assert.equal(result.ok, false)
  assert.ok(result.summary.length > 0, 'a failure must still carry a human-readable reason')
  assert.equal(result.data, null)
  assert.deepEqual(findLossy(result), [])
})

test('findLossy actually detects the failure mode it guards against', () => {
  // 保证这个守卫本身不是假阳性：构造一个已知有问题的对象，它必须报出来。
  const broken = { ok: true, summary: 'x', data: { port: undefined } }
  const problems = findLossy(broken)
  assert.equal(problems.length, 1)
  assert.match(problems[0], /port: undefined/)
})

test('the facts the panel actually reads stay lossless', () => {
  // cpuModel / cpuCount 是 app/ViewModels.cs 渲染「型号 ×核心数」用的键，
  // 以前根本没人往 facts 里放；放进去了也仍然必须过 lossless 这一关。
  return remoteStatus(makeManager(), { target: 'ubuntu' }).then((result) => {
    assert.equal(result.ok, true)
    assert.deepEqual(findLossy(result), [])
    const target = result.data.targets.find((t) => t.id === 'wsl-ubuntu-2404')
    assert.equal(target.facts.cpuModel, 'Intel(R) Core(TM) i5-8200Y CPU @ 1.30GHz')
    assert.equal(target.facts.cpuCount, 2)
    assert.equal(target.cpuCount, 2)
  })
})

test('an ambiguous target selector fails cleanly instead of hitting an arbitrary machine', async () => {
  // 两个目标（wsl-ubuntu-2404 / ssh-prod-backup）的 id 里都含 "u" → 真正的歧义。
  // 以前工具走 manager.getTarget 会**悄悄挑第一个**，命令走另一套会报错。
  const result = await remoteStatus(makeManager({ secondTarget: true }), { target: 'u' })
  assert.equal(result.ok, false)
  assert.match(result.summary, /matches 2 targets/)
  assert.equal(result.data, null)
  assert.deepEqual(findLossy(result), [])
})

test('an unknown target selector fails with the list of what is available', async () => {
  const result = await remoteStatus(makeManager(), { target: 'nope' })
  assert.equal(result.ok, false)
  assert.match(result.summary, /no target matching "nope"/)
  assert.match(result.summary, /Configured targets:/)
  assert.deepEqual(findLossy(result), [])
})

test('remote_panel rejects an action outside its enum', async () => {
  // 原始 JSON Schema 注册路径不保证 enum 被执行，所以实现层必须自己挡。
  const result = await remotePanel(makeManager(), { action: 'open-ish' }, { panelExe: () => '' })
  assert.equal(result.ok, false)
  assert.match(result.summary, /action must be "open" or "status"/)
  assert.deepEqual(findLossy(result), [])
})

test('remote_panel explains that MCP has no launcher, with a usable alternative', async () => {
  const result = await remotePanel(makeManager(), { action: 'open' }, {})
  assert.equal(result.ok, false)
  assert.match(result.summary, /action: "status"/)
  assert.deepEqual(findLossy(result), [])
})
