/**
 * dsh-remote-panel —— 会话命令（`/wsx ...`）
 * ============================================================================
 * DSH 命令是「不经过模型」的用户操作入口：敲下去、立刻拿到一段文本结果。
 * 所以这里的输出是**给人看的**（对齐、单位、颜色无关的纯文本），
 * 而给模型看的结构化结果走 `tools.js`。
 *
 * 命令名必须是 `^[a-z][a-z0-9_-]*$`，所以用了 `wsx`。
 * 注意 `invocation.rawInput` 是 `/wsx` 之后的**原样**字符串（含前导空格），
 * 必须自己 trim —— DSH 不做这件事。
 */

// 只 import `/wsx` 真正用得上的操作。
// 这里曾经 import 了 targetLabel 与一批 docker/文件读写函数但从未使用 ——
// 死 import 会让「这个模块到底依赖什么」变得不可信，也容易掩盖重构遗留。
import { requireTargetSelector, resolveTargetSelector } from './config.js'
import { ago, humanBytes, pad, statusGlyph } from './format.js'
import { dockerPs, listProcesses, serviceStatus } from './ops.js'
import { toolRegistrationState } from './tools.js'

const HELP = [
  '/wsx                    本机 WSL 与远程机器的状态总览',
  '/wsx status [目标]      状态总览（可只看一个目标）',
  '/wsx list               列出所有配置目标及通道',
  '/wsx probe [目标]       立刻探测（不带目标则全部）',
  '/wsx docker [目标]      列出容器',
  '/wsx services [目标]    列出关键服务状态',
  '/wsx ps [目标] [n]      列出 CPU 占用最高的进程',
  '/wsx exec <目标> <命令> 在目标上执行一条只读命令',
  '/wsx panel              显示 / 前置状态预览面板窗口',
  '/wsx open               打开插件的数据目录与状态文件',
  '',
  '目标可以用 id、名称或主机名的一部分来指定。',
].join('\n')

/** 一个目标的紧凑一行。 */
function targetLine(target) {
  const status = statusGlyph(target.status)
  const mem = target.metrics?.memory
  const cpu = target.metrics?.cpu?.usagePercent
  const parts = [
    `${status} ${pad(target.name, 22)}`,
    pad(target.kind === 'wsl' ? `WSL ${target.host}` : `${target.host}${target.port && target.port !== 22 ? `:${target.port}` : ''}`, 26),
  ]
  if (target.status === 'online') {
    parts.push(pad(`CPU ${cpu === undefined ? '—' : `${cpu}%`}`, 12))
    parts.push(pad(`MEM ${mem?.usagePercent === undefined ? '—' : `${mem.usagePercent}%`} ${mem?.totalBytes ? `/${humanBytes(mem.totalBytes)}` : ''}`, 22))
    const worst = target.metrics?.disks?.[0]
    if (worst) parts.push(pad(`DISK ${worst.mount} ${worst.usagePercent ?? '—'}%`, 22))
    parts.push(target.latencyMs ? `${target.latencyMs}ms` : '')
  } else {
    parts.push(pad(target.error ? target.error.slice(0, 60) : 'not probed yet', 60))
  }
  return parts.join('').trimEnd()
}

/** 总览：totals + 每个目标一行 + 错误条。 */
export function renderStatus(snapshot, { title = '远程目标状态' } = {}) {
  const lines = []
  const { totals } = snapshot
  lines.push(`${title} · ${totals.targets} 个目标 · ${totals.online} 在线 · ${totals.offline} 离线${totals.probing ? ` · ${totals.probing} 探测中` : ''}`)
  if (snapshot.host?.configErrors?.length) {
    lines.push('')
    lines.push('配置问题：')
    for (const error of snapshot.host.configErrors) lines.push(`  ! ${error}`)
  }
  lines.push('')
  if (!snapshot.targets.length) {
    lines.push('没有配置任何目标。在 cordis.patch.yml 的 dsh-remote-panel 行里加 targets。')
  } else {
    for (const target of snapshot.targets) lines.push(targetLine(target))
  }
  if (snapshot.errors?.length) {
    lines.push('')
    lines.push(`失败 ${snapshot.errors.length} 个：`)
    for (const error of snapshot.errors) {
      lines.push(`  ✕ ${error.name}（连续 ${error.consecutiveFailures} 次）: ${error.error}`)
    }
  }
  lines.push('')
  lines.push(`更新于 ${ago(snapshot.generatedAt)} · 状态文件 ${snapshot.host?.stateFile ?? '—'}`)
  return lines.join('\n')
}

/** `/wsx list`：把配置本身列出来，包括走哪条通道。 */
export function renderTargetList(manager) {
  const lines = ['已配置的目标：', '']
  if (!manager.runtimes.length) {
    lines.push('  （空）')
    return lines.join('\n')
  }
  for (const runtime of manager.runtimes) {
    const t = runtime.target
    const channel = t.kind === 'wsl' ? `wsl.exe${t.channel === 'auto' ? ' (auto: ssh → wsl)' : ` (${t.channel})`}` : 'ssh'
    lines.push(`  ${pad(t.id, 26)} ${pad(t.name, 22)} ${pad(t.kind.toUpperCase(), 5)} ${pad(t.kind === 'wsl' ? t.distro : `${t.host}:${t.port}`, 30)} ${channel}`)
    if (t.tags.length) lines.push(`  ${''.padEnd(26)} tags: ${t.tags.join(', ')}`)
  }
  lines.push('')
  lines.push(
    `探测间隔 ${manager.config.probeIntervalMs}ms · 超时 ${manager.config.timeoutMs}ms · 并发 ${manager.config.maxConcurrentProbes} · 写操作${manager.config.allowMutations === false ? '已禁用' : '已启用'}`,
  )
  // 工具注册路径直接影响「模型看到的 schema 是否经过校验」，出问题时这是第一条线索。
  lines.push(`工具注册路径：${toolRegistrationState()}`)
  return lines.join('\n')
}

/**
 * 解析 selector 并给出「找不到 / 多个匹配 / 没给」时的可操作提示。
 *
 * 只配了一个目标时，省略目标名是常态（`/wsx docker`），所以直接用它。
 * 以前这种情况会报 `"" matches N targets` 或 `no target matching ""` ——
 * 对一个单目标部署来说，这两句话都答非所问。
 */
function resolveOrThrow(manager, selector) {
  const targets = manager.runtimes.map((r) => r.target)
  if (!String(selector ?? '').trim()) {
    if (targets.length === 1) return targets[0]
    throw new Error(
      targets.length
        ? `请指定目标。已配置：${targets.map((t) => t.id).join(', ')}`
        : '没有配置任何目标。在 cordis.patch.yml 的 dsh-remote-panel 行里加 targets。',
    )
  }
  const { target, candidates } = resolveTargetSelector(targets, selector)
  if (target) return target
  if (candidates && candidates.length > 1) {
    throw new Error(
      `${JSON.stringify(selector)} 匹配到 ${candidates.length} 个目标：${candidates.map((c) => c.id).join(', ')} —— 请写得更具体一些`,
    )
  }
  return requireTargetSelector(targets, selector)
}
/**
 * 命令处理主体。返回 `{ kind, text }`。
 * 所有异常都在这里收敛成 `kind: 'error'` —— DSH 要求 error 的 text 非空。
 */
export async function handleWsxCommand(manager, invocation, helpers) {
  const raw = String(invocation.rawInput ?? '').trim()
  const tokens = raw.split(/\s+/).filter(Boolean)
  const sub = (tokens.shift() ?? '').toLowerCase()

  try {
    switch (sub) {
      case '':
      case 'status': {
        const selector = tokens.join(' ')
        if (selector) {
          const target = resolveOrThrow(manager, selector)
          const snapshot = manager.snapshot()
          const only = snapshot.targets.filter((t) => t.id === target.id)
          return { kind: 'success', text: renderStatus({ ...snapshot, targets: only }, { title: `目标 ${target.name}` }) }
        }
        return { kind: 'success', text: renderStatus(manager.snapshot()) }
      }

      case 'list':
        return { kind: 'success', text: renderTargetList(manager) }

      case 'probe': {
        const selector = tokens.join(' ')
        if (selector) {
          const target = resolveOrThrow(manager, selector)
          const runtime = (await manager.wake(target.id))[0]
          return {
            kind: 'success',
            text: `${renderStatus(manager.snapshot(), { title: `已探测 ${target.name}` })}\n\n本次结果：${runtime?.status ?? '未知'}${runtime?.error ? ` — ${runtime.error}` : ''}`,
          }
        }
        const results = await manager.wake()
        const failed = results.filter((r) => r.status === 'offline').length
        return {
          kind: 'success',
          text: `已探测 ${results.length} 个目标，${failed} 个失败。\n\n${renderStatus(manager.snapshot())}`,
        }
      }

      case 'docker': {
        const target = resolveOrThrow(manager, tokens.join(' '))
        const listing = await dockerPs(target, manager.config, { all: true, limit: 60 })
        if (!listing.available) return { kind: 'success', text: `${target.name} 上没有 docker CLI。` }
        if (listing.error) return { kind: 'success', text: `${target.name} 上的 docker 不可用：${listing.error}` }
        if (!listing.containers.length) return { kind: 'success', text: `${target.name} 上没有容器。` }
        const lines = [`${target.name} · ${listing.containers.length} 个容器`, '']
        for (const c of listing.containers) {
          lines.push(`  ${pad(c.state, 9)} ${pad(c.name, 28)} ${pad(c.image, 34)} ${c.status}`)
        }
        return { kind: 'success', text: lines.join('\n') }
      }

      case 'services': {
        const target = resolveOrThrow(manager, tokens.join(' '))
        const runtime = manager.runtimeFor(target.id)
        const watch = runtime?.target.services?.length ? runtime.target.services : undefined
        const result = await serviceStatus(target, manager.config, { services: watch ?? [] })
        if (!result.services.length) return { kind: 'success', text: `${target.name} 上没有查到服务（${result.runner}）。` }
        const lines = [`${target.name} · ${result.runner} · ${result.services.length} 个服务`, '']
        for (const s of result.services) {
          lines.push(`  ${pad(s.active === 'active' ? '●' : '○', 3)} ${pad(s.name, 34)} ${pad(s.active, 12)} ${s.sub ?? ''}`)
        }
        return { kind: 'success', text: lines.join('\n') }
      }

      case 'ps': {
        // `/wsx ps <目标> [n]` 或 `/wsx ps <n> <目标>` —— 两种写法都容忍。
        const numeric = tokens.find((t) => /^\d+$/.test(t))
        const rest = tokens.filter((t) => t !== numeric).join(' ')
        const target = resolveOrThrow(manager, rest)
        const limit = numeric ? Number(numeric) : 12
        const listing = await listProcesses(target, manager.config, { sort: 'cpu', limit })
        const lines = [`${target.name} · CPU 占用最高的 ${listing.processes.length} 个进程`, '']
        for (const p of listing.processes) {
          lines.push(`  ${pad(p.pid, 8)} ${pad(p.user, 12)} ${pad(`${p.cpuPercent}%`, 8)} ${pad(`${p.memPercent}%`, 8)} ${pad(p.elapsed, 12)} ${p.command.slice(0, 70)}`)
        }
        return { kind: 'success', text: lines.join('\n') }
      }

      case 'exec': {
        // `/wsx exec <目标> <命令>`：目标之后的内容整条当命令，不再分词。
        // 用正则而不是 indexOf(' ')：`/wsx exec\t目标 命令`（脚本或智能体发的
        // 输入里很容易带制表符）以前会被判成「用法错误」。
        const match = /^exec\s+(\S+)\s+([\s\S]+)$/.exec(raw)
        if (!match) return { kind: 'error', text: '用法：/wsx exec <目标> <命令>' }
        const selector = match[1]
        const command = match[2].trim()
        if (!command) return { kind: 'error', text: '用法：/wsx exec <目标> <命令>' }
        const target = resolveOrThrow(manager, selector)
        const result = await helpers.execOnTarget(target, command)
        // 超时时 stderr 是空的，原因在 result.error 里 —— 不带出来就只剩
        // 「退出码 —」，既看不出是超时，也看不到该往哪查。
        const body = [result.stdout, result.stderr, !result.ok && !result.stderr ? result.error : '']
          .filter(Boolean)
          .join('\n')
          .trimEnd()
        const reason = result.timedOut ? `超时（${result.ms}ms）` : `退出码 ${result.code ?? '—'}`
        return {
          kind: 'success',
          text: `${target.name} $ ${command}\n${reason} · ${result.ms}ms · 通道 ${result.channel}\n\n${body || '（无输出）'}`,
        }
      }

      case 'panel': {
        const launched = helpers.launchPanel()
        if (!launched.ok) return { kind: 'error', text: launched.message }
        return { kind: 'success', text: launched.message }
      }

      case 'open':
        return { kind: 'success', text: helpers.openDataDirectory() }

      case 'help':
        return { kind: 'success', text: HELP }

      default:
        return { kind: 'error', text: `未知子命令 ${JSON.stringify(sub)}。\n\n${HELP}` }
    }
  } catch (error) {
    return { kind: 'error', text: `${sub || 'wsx'} 失败：${error?.message ?? error}` }
  }
}

/** 注册 `/wsx`。返回 disposer。 */
export function registerWsxCommand(ctx, manager, helpers) {
  return ctx.commands.register({
    name: 'wsx',
    description: '查看本机 WSL 与远程机器（SSH）的状态、容器、服务与进程',
    input: { hint: '[status|list|probe|docker|services|ps|exec|panel|open|help] [目标]', attachments: false },
    handler: (invocation) => handleWsxCommand(manager, invocation, helpers),
  })
}

export { resolveOrThrow }
