/**
 * dsh-remote-panel —— 工具实现（与 API 无关的纯函数层）
 * ============================================================================
 * 这里只有「拿到 manager + 参数 → 返回结果」的逻辑，不依赖 DSH，也不依赖 MCP。
 * 三个消费方共用它，保证行为与校验完全一致：
 *
 *   - `tools.js`  —— 注册成 DSH 原生工具（模型直接调用）
 *   - `mcp-server.js` —— 通过 MCP stdio 暴露给任意 MCP 客户端
 *
 * 这个分层是有意的：如果 MCP 那份重新实现一遍参数校验与命令拼装，两边就会漂，
 * 而「哪一边允许什么」正是最不该漂的地方（写操作的闸门全在这里）。
 *
 * 统一返回 `{ ok, summary, data }`；**不抛异常** —— 失败是一种正常结果。
 */

import {
  dockerAction,
  dockerLogs,
  dockerPs,
  downloadFile,
  killProcess,
  listProcesses,
  listRemoteDirectory,
  readRemoteFile,
  serviceAction,
  serviceStatus,
  uploadFile,
} from './ops.js'
import { ago, humanBytes } from './format.js'
import { effectiveTimeoutMs, listTargets, requireTargetSelector } from './config.js'
import { runRemote } from './ssh.js'
import { flatten, pruneUndefined } from './util.js'

/**
 * 把要返回给调用方的 `data` 洗成**无损 JSON**。
 *
 * 为什么必须有这一步：`TargetRuntime.toJSON()` 会为缺失字段显式产出 `undefined`
 * （写状态文件时无害，因为 `JSON.stringify` 会把它们丢掉）。但工具的**返回值**
 * 要过 DSH 的 lossless-JSON 校验，一个 `undefined` 属性就会让整个调用失败，
 * 而且报错只说「value is not lossless JSON」，不告诉你哪个字段 —— 极难定位。
 *
 * 所以所有 `data` 在离开这一层之前统一过一遍 prune。
 * `NaN`/`Infinity` 也一并处理：它们序列化成 `null`，同样会破坏 round-trip。
 */
function lossless(value) {
  const pruned = pruneUndefined(value)
  return scrubNonFinite(pruned)
}

function scrubNonFinite(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (Array.isArray(value)) return value.map(scrubNonFinite)
  if (value && typeof value === 'object') {
    const out = {}
    for (const [key, item] of Object.entries(value)) out[key] = scrubNonFinite(item)
    return out
  }
  return value
}

/** 统一构造成功结果，顺带保证 data 无损。 */
function succeed(summary, data) {
  return { ok: true, summary, data: data === undefined ? null : lossless(data) }
}

/** 统一构造失败结果。 */
function fail(summary) {
  return { ok: false, summary, data: null }
}

/** 把可能抛异常的操作收敛成 `{ ok:false, summary }`。 */
async function attempt(fn) {
  try {
    return { ok: true, value: await fn() }
  } catch (error) {
    return { ok: false, error: flatten(error?.message || error, 600) }
  }
}

/** 解析目标；找不到或**匹配到多个**时抛出一句带候选清单的错误。
 *
 * 以前这里用的是 manager.getTarget（「子串命中第一个」），而 `/wsx` 用的是
 * 「歧义就报错」—— 同一个选择器在两条路径上会指向不同的机器。选择器语义只能有一处，
 * 所以两边都走 config.requireTargetSelector。
 */
export function requireTarget(manager, selector) {
  return requireTargetSelector(
    manager.runtimes.map((r) => r.target),
    selector,
    {
      missing: `"target" is required. Configured targets: ${listTargets(manager.runtimes.map((r) => r.target))}`,
    },
  )
}

/** 把捕获到的输出按上限截断，并标注被截掉多少。 */
function truncateText(text, maxBytes) {
  const str = String(text ?? '')
  if (str.length <= maxBytes) return str
  return `${str.slice(0, maxBytes)}\n… [truncated ${str.length - maxBytes} bytes]`
}

function processTable(processes) {
  return processes
    .map(
      (p) =>
        `  ${String(p.pid).padStart(7)} ${String(p.cpuPercent).padStart(6)}% ${String(p.memPercent).padStart(6)}% ${p.elapsed.padEnd(10)} ${p.command.slice(0, 80)}`,
    )
    .join('\n')
}

// ---------------------------------------------------------------------------
// 实现
// ---------------------------------------------------------------------------

export async function remoteStatus(manager, args = {}) {
  const selector = args?.target ? String(args.target) : ''
  const result = await attempt(async () => {
    // 只解析一次：以前这里 requireTarget 被调了 2–3 遍（refresh 分支 + 过滤分支），
    // 每次都要把所有运行时的目标遍历一遍。
    const only = selector ? requireTarget(manager, selector) : undefined
    if (args?.refresh === true) {
      if (only) await manager.wake(only.id)
      else await manager.wake()
    }
    const snapshot = manager.snapshot()
    const targets = only ? snapshot.targets.filter((t) => t.id === only.id) : snapshot.targets

    const lines = targets.map((t) => {
      if (t.status !== 'online') return `${t.name} [${t.kind}] ${t.status}${t.error ? ` — ${t.error}` : ''}`
      const bits = [`${t.name} [${t.kind}] online`]
      if (t.metrics?.cpu?.usagePercent !== undefined) bits.push(`cpu ${t.metrics.cpu.usagePercent}%`)
      if (t.metrics?.memory?.usagePercent !== undefined) {
        bits.push(`mem ${t.metrics.memory.usagePercent}%/${humanBytes(t.metrics.memory.totalBytes)}`)
      }
      if (t.metrics?.disks?.length) bits.push(`disk max ${t.metrics.disks[0].mount} ${t.metrics.disks[0].usagePercent}%`)
      if (t.metrics?.docker?.available) bits.push(`docker ${t.metrics.docker.running ?? 0} running`)
      if (t.latencyMs) bits.push(`${t.latencyMs}ms`)
      return bits.join(' · ')
    })

    return {
      totals: snapshot.totals,
      generatedAt: snapshot.generatedAt,
      ageText: ago(snapshot.generatedAt),
      targets,
      errors: snapshot.errors,
      configErrors: snapshot.host?.configErrors ?? [],
      text: lines.join('\n'),
    }
  })

  if (!result.ok) return fail(result.error)
  const data = result.value
  return succeed(
    `${data.totals.targets} targets · ${data.totals.online} online · ${data.totals.offline} failing (updated ${data.ageText})\n${data.text}`,
    data,
  )
}

export async function remoteExec(manager, args = {}) {
  const target = requireTarget(manager, args.target)
  const command = String(args.command ?? '')
  if (!command.trim()) return fail('command is required')
  const maxBytes = Math.max(1024, Math.min(Number(args.maxBytes) || 65_536, 4_194_304))

  const result = await attempt(() =>
    runRemote(target, manager.config, command, {
      // 「配置的超时」= 该目标生效的值（targets[].timeoutMs 优先）——
      // 目标级覆盖的存在意义就是让所有打到这台机器的操作都受它约束。
      timeoutMs: Number.isFinite(Number(args.timeoutMs))
        ? Math.max(3000, Math.min(Number(args.timeoutMs), 600_000))
        : effectiveTimeoutMs(target, manager.config),
    }),
  )
  if (!result.ok) return fail(result.error)

  const run = result.value
  const data = {
    target: target.id,
    channel: run.channel,
    exitCode: run.code,
    // 超时与「命令自己退出非零」是两回事：前者大概率是链路/冷启动，后者是命令的问题。
    timedOut: run.timedOut === true,
    durationMs: run.ms,
    stdout: truncateText(run.stdout, maxBytes),
    stderr: truncateText(run.stderr, maxBytes),
    error: run.error,
  }
  // 失败原因必须显示出来。超时时 stderr 是空的，而 run.error 里才是
  // 「timed out after 3s ... cold WSL start ...」那句 —— 以前这里只看
  // stdout/stderr，于是超时在调用方看来只是 `exit null`，没有任何线索。
  const output = flatten(run.stderr || run.stdout, 2000)
  const reason = run.timedOut ? `timed out after ${Math.round(run.ms / 1000)}s` : `exit ${run.code}`
  // 这里刻意不用 succeed()：`ok` 反映的是**远程命令的退出码**，不是链路是否成功。
  // 命令以非零码退出是一条有效的观察结果，不是工具失败。
  return {
    ok: run.code === 0,
    summary:
      run.code === 0
        ? `${target.name}: exit 0 in ${run.ms}ms (${run.channel})\n${flatten(run.stdout, 2000) || '(no output)'}`
        : `${target.name}: ${reason} in ${run.ms}ms (${run.channel})\n${output || run.error || '(no output)'}`,
    data: lossless(data),
  }
}

export async function remoteFiles(manager, args = {}) {
  const target = requireTarget(manager, args.target)
  const operation = String(args.operation ?? '')
  const remotePath = String(args.remotePath ?? '')

  const result = await attempt(async () => {
    switch (operation) {
      case 'list': {
        const listing = await listRemoteDirectory(target, manager.config, remotePath)
        return {
          summary: `${target.name}:${listing.path} — ${listing.entries.length} entries${listing.truncated ? ' (truncated)' : ''}`,
          data: listing,
        }
      }
      case 'read': {
        const file = await readRemoteFile(target, manager.config, remotePath, args.maxBytes)
        return {
          summary: `${target.name}:${file.path} — ${humanBytes(file.totalBytes)}${file.truncated ? ' (truncated)' : ''}\n${flatten(file.content, 2000)}`,
          data: file,
        }
      }
      case 'upload': {
        const uploaded = await uploadFile(target, manager.config, {
          localPath: args.localPath,
          remotePath,
          makeDirs: args.makeDirs === true,
          mode: args.mode,
        })
        // warnings 只在「上传成功但有件事没做成」时出现（例如 chmod 被拒），
        // 必须显示出来 —— 否则调用方以为权限也改好了。
        const warning = uploaded.warnings?.length ? `\n! ${uploaded.warnings.join('\n! ')}` : ''
        return {
          summary: `Uploaded ${humanBytes(uploaded.bytes)} to ${target.name}:${uploaded.remotePath} via ${uploaded.via} in ${uploaded.durationMs}ms${warning}`,
          data: uploaded,
        }
      }
      case 'download': {
        const downloaded = await downloadFile(target, manager.config, {
          remotePath,
          localPath: args.localPath,
          overwrite: args.overwrite === true,
        })
        return {
          summary: `Downloaded ${humanBytes(downloaded.bytes)} from ${target.name}:${downloaded.remotePath} to ${downloaded.localPath} via ${downloaded.via}`,
          data: downloaded,
        }
      }
      default:
        throw new Error(`operation must be list, read, upload or download (got ${JSON.stringify(args.operation)})`)
    }
  })

  if (!result.ok) return fail(result.error)
  return succeed(result.value.summary, result.value.data)
}

export async function remoteDocker(manager, args = {}) {
  const target = requireTarget(manager, args.target)
  const operation = String(args.operation ?? '')

  const result = await attempt(async () => {
    if (operation === 'ps') {
      const listing = await dockerPs(target, manager.config, { all: args.all !== false, limit: 60 })
      if (!listing.available) return { summary: `${target.name}: no docker CLI on this target`, data: listing }
      if (listing.error) return { summary: `${target.name}: docker unavailable — ${listing.error}`, data: listing }
      const text = listing.containers.map((c) => `  ${c.state.padEnd(9)} ${c.name} (${c.image}) — ${c.status}`).join('\n')
      return { summary: `${target.name}: ${listing.containers.length} containers\n${text || '  (none)'}`, data: listing }
    }
    if (operation === 'logs') {
      const logs = await dockerLogs(target, manager.config, {
        container: args.container,
        lines: args.lines,
        since: args.since,
      })
      return {
        summary: `${target.name}: last ${logs.lines} lines of ${logs.container}${logs.truncated ? ' (truncated)' : ''}\n${flatten(logs.output, 3000)}`,
        data: logs,
      }
    }
    const action = await dockerAction(target, manager.config, {
      container: args.container,
      action: operation,
      timeoutSec: args.timeoutSec,
    })
    return { summary: `${target.name}: docker ${action.action} ${action.container} → ${action.output}`, data: action }
  })

  if (!result.ok) return fail(result.error)
  return succeed(result.value.summary, result.value.data)
}

export async function remoteServices(manager, args = {}) {
  const target = requireTarget(manager, args.target)
  const operation = String(args.operation ?? '')

  const result = await attempt(async () => {
    if (operation === 'status') {
      const runtime = manager.runtimeFor(target.id)
      const watch =
        Array.isArray(args.services) && args.services.length
          ? args.services.map(String)
          : runtime?.target.services?.length
            ? runtime.target.services
            : undefined
      const status = await serviceStatus(target, manager.config, { services: watch ?? [] })
      const text = status.services
        .map((s) => `  ${s.active === 'active' ? '●' : '○'} ${s.name} — ${s.active}${s.sub ? `/${s.sub}` : ''}`)
        .join('\n')
      return { summary: `${target.name} (${status.runner}): ${status.services.length} services\n${text || '  (none)'}`, data: status }
    }
    const action = await serviceAction(target, manager.config, { service: args.service, action: operation })
    return {
      summary: `${target.name}: service ${action.action} ${action.service} → ${flatten(action.output, 400) || 'ok'}`,
      data: action,
    }
  })

  if (!result.ok) return fail(result.error)
  return succeed(result.value.summary, result.value.data)
}

export async function remoteProcesses(manager, args = {}) {
  const target = requireTarget(manager, args.target)
  const operation = String(args.operation ?? '')

  const result = await attempt(async () => {
    if (operation === 'list') {
      const listing = await listProcesses(target, manager.config, {
        sort: args.sort === 'mem' ? 'mem' : 'cpu',
        limit: args.limit,
        filter: args.filter,
      })
      return {
        summary: `${target.name}: top ${listing.processes.length} by ${listing.sort}${listing.filter ? ` (filter "${listing.filter}")` : ''}\n${processTable(listing.processes) || '  (none)'}`,
        data: listing,
      }
    }
    const killed = await killProcess(target, manager.config, {
      pid: args.pid,
      signal: args.signal,
      confirm: args.confirm === true,
    })
    return {
      summary: killed.killed
        ? `${target.name}: sent SIG${killed.signal} to ${killed.pid} (${killed.identity})`
        : `${target.name}: did not signal ${killed.pid} — ${killed.reason || killed.error || 'unknown reason'}`,
      data: killed,
    }
  })

  if (!result.ok) return fail(result.error)
  return succeed(result.value.summary, result.value.data)
}

/** 面板相关。`helpers` 由调用方注入（DSH 侧有真实 launcher，MCP 侧只有状态文件信息）。 */
export async function remotePanel(manager, args = {}, helpers = {}) {
  const action = String(args.action ?? '')
  if (action === 'open') {
    if (typeof helpers.launchPanel !== 'function') {
      return fail('no panel launcher is available in this context (the MCP server only reports the state file; use action: "status")')
    }
    const launched = helpers.launchPanel()
    // ok 跟的是「窗口有没有起来」，所以这里也不用 succeed()。
    return {
      ok: launched.ok,
      summary: launched.message,
      data: lossless({ exe: launched.exe || null, launched: launched.launched }),
    }
  }
  // 显式校验 action：原始 JSON Schema 注册路径不保证 enum 被强制执行，
  // 而「写错了却悄悄返回 status」会让调用方以为窗口打开了。
  if (action !== 'status') {
    return fail(`action must be "open" or "status" (got ${JSON.stringify(args.action)})`)
  }
  const snapshot = manager.snapshot()
  return succeed(`Panel state file: ${manager.config.stateFile} · ${snapshot.totals.targets} targets`, {
    stateFile: manager.config.stateFile,
    exe: typeof helpers.panelExe === 'function' ? helpers.panelExe() || null : null,
    totals: snapshot.totals,
  })
}
