/**
 * dsh-remote-panel —— 配置规范化
 * ============================================================================
 * 把 cordis.patch.yml 里的原始 config 洗成一份**内部保证形状**的配置对象，
 * 所有目标条目在这里补齐默认值、算出稳定 id、并做去重。
 *
 * 为什么不用 schemastery 的 Config：
 *   本插件接受一个可选的 `targetsFile`，而 schemastery 无法表达「从另一个文件
 *   读数组」这种动态补全。所以这里手写规范化，并把 Config 校验留在
 *   validateRawConfig() 里显式调用，错误信息更贴近使用者看到的东西。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { clamp, flatten } from './util.js'

const DEFAULT_PROBE_INTERVAL_MS = 15_000
/**
 * 单次探测的全局超时（毫秒）。
 *
 * 默认给到 60 秒是被 WSL 逼出来的：WSL 在最后一次 `wsl.exe` 会话结束后约一分钟
 * 就把整个发行版拆掉，所以空闲后的首次探测要付 **18–88 秒**冷启动代价
 * （见 README「坑 2」）。早先默认 20 秒，结果本机 WSL 目标每隔几轮就被判一次
 * 「离线」—— 数据其实是对的，只是没等到。
 *
 * 为什么**不**把它降下来（2024 复核）：本机实测稳态探测 1.7–4.3s（channel: wsl，
 * 连续 5 次），SSH 复用热探测约 80ms，看起来 60s 很富余；但冷启动代价是
 * 同一个目标、同一条通道上的真实情况，而降超时正是当年踩过的那个坑。
 * 而且「机器真的宕了」并不会因此白等 60 秒 —— ssh 的 `ConnectTimeout`
 * （connectTimeoutMs，默认 10s）先兜住了连接阶段，60s 只对「连得上但很慢」的目标
 * 生效，那恰好就是冷启动 WSL 的形状。
 *
 * 所以这里保留 60s，把选择权交给目标级覆盖：`targets[].timeoutMs` 能单独收紧
 * 某一个目标（例如已经常驻热的 WSL，或纯 SSH 部署），不必为了一个目标放宽全局。
 */
const DEFAULT_TIMEOUT_MS = 60_000
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000
const DEFAULT_HISTORY_LENGTH = 40
/** 超时的允许区间：目标级覆盖与全局值共用。 */
const MIN_TIMEOUT_MS = 3000
const MAX_TIMEOUT_MS = 600_000

/** 目标 id 白名单：要能安全地出现在 URL 路径、JSON 键和命令行里。 */
const TARGET_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

/**
 * 把 `~` 展开成家目录。SSH 自己也认 `~`，但我们在 Node 侧要先做
 * existsSync 判断，所以必须展开。
 */
export function expandHome(p) {
  const text = String(p ?? '').trim()
  if (!text) return ''
  if (text === '~') return os.homedir()
  if (text.startsWith('~/') || text.startsWith('~\\')) {
    return path.join(os.homedir(), text.slice(2))
  }
  return text
}

/** DSH_HOME 的解析：与其它 DSH 插件保持一致，先看环境变量。 */
export function resolveDshHome() {
  const fromEnv = String(process.env.DSH_HOME ?? '').trim()
  if (fromEnv) return fromEnv
  return path.join(os.homedir(), '.dsh')
}

/** 状态文件路径。 */
export function resolveStateFile(config) {
  const explicit = expandHome(config?.stateFile)
  if (explicit) return explicit
  return path.join(resolveDshHome(), 'remote-panel', 'state.json')
}

/**
 * 每个目标一个稳定 id。优先用配置里显式给的 id；否则由 kind+host+user 派生。
 * 派生出的 id 必须**稳定**：面板用它做 React key 和排序，插件重载后不该变。
 */
export function deriveTargetId(target) {
  const explicit = String(target?.id ?? '').trim()
  if (explicit) {
    if (!TARGET_ID_RE.test(explicit)) {
      throw new Error(
        `target id ${JSON.stringify(explicit)} is invalid: use letters, digits, dot, underscore or hyphen (max 64 chars, must not start with punctuation)`,
      )
    }
    return explicit
  }
  const kind = String(target?.kind ?? 'ssh').toLowerCase()
  const host = String(target?.host ?? target?.distro ?? '').trim()
  const user = String(target?.user ?? '').trim()
  const raw = `${kind}-${user ? `${user}-` : ''}${host}`
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
  if (!slug) throw new Error('target needs a host (or a distro for kind=wsl)')
  return slug
}

/**
 * 目标级的超时覆盖：不写就返回 undefined（用全局 timeoutMs）。
 * 非法值一律当作「没写」而不是报错 —— 一个数字写错不该让整个目标消失。
 */
function normalizeTargetTimeout(value) {
  if (value === undefined || value === null || value === '') return undefined
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined
  return clamp(parsed, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS)
}

/**
 * 某个目标实际生效的探测超时：目标级覆盖优先，否则用全局值。
 * 所有通道都走这里取超时，避免「配置里写了但没人读」。
 */
export function effectiveTimeoutMs(target, config) {
  const perTarget = Number(target?.timeoutMs)
  if (Number.isFinite(perTarget) && perTarget > 0) return clamp(perTarget, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS)
  const global = Number(config?.timeoutMs)
  return Number.isFinite(global) && global > 0 ? global : DEFAULT_TIMEOUT_MS
}

/** 规范化单个目标。抛出的错误带上目标名字，方便使用者定位是哪一个配错了。 */
function normalizeTarget(raw, index, sshDefaults) {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`targets[${index}] must be an object`)
  }
  const kind = String(raw.kind ?? 'ssh').toLowerCase()
  if (kind !== 'ssh' && kind !== 'wsl') {
    throw new Error(`targets[${index}].kind must be "ssh" or "wsl" (got ${JSON.stringify(raw.kind)})`)
  }

  const label = String(raw.name ?? '').trim()

  if (kind === 'wsl') {
    const distro = String(raw.distro ?? raw.host ?? '').trim()
    if (!distro) {
      throw new Error(`targets[${index}] (${label || 'unnamed'}): kind=wsl requires "distro"`)
    }
    const channel = String(raw.channel ?? 'auto').toLowerCase()
    if (!['auto', 'wsl', 'ssh'].includes(channel)) {
      throw new Error(`targets[${index}].channel must be "auto", "wsl" or "ssh"`)
    }
    // WSL 走 SSH 时的默认落点：wsl-link 那套在本机 127.0.0.1:2222 上跑了仅回环的 sshd，
    // 而且在受限沙箱下依然可用（wsl.exe 会被 WSL 服务拒绝）。所以 SSH 是首选通道。
    const sshPort = Number(raw.sshPort ?? raw.port ?? 2222)
    return {
      kind,
      id: deriveTargetId({ ...raw, kind, host: distro }),
      name: label || distro,
      distro,
      host: '127.0.0.1',
      port: Number.isFinite(sshPort) && sshPort > 0 ? sshPort : 2222,
      user: String(raw.user ?? '').trim() || 'root',
      channel,
      identityFile: expandHome(raw.identityFile),
      strictHostKeyChecking: raw.strictHostKeyChecking !== false,
      timeoutMs: normalizeTargetTimeout(raw.timeoutMs),
      tags: Array.isArray(raw.tags) ? raw.tags.map((t) => String(t)) : [],
      enabled: raw.enabled !== false,
      services: Array.isArray(raw.services) ? raw.services.map((s) => String(s)) : [],
    }
  }

  // kind === 'ssh'
  const host = String(raw.host ?? raw.hostname ?? raw.ip ?? '').trim()
  if (!host) {
    throw new Error(`targets[${index}] (${label || 'unnamed'}): kind=ssh requires "host" (an IP or hostname)`)
  }
  const port = Number(raw.port ?? sshDefaults.port ?? 22)
  return {
    kind,
    id: deriveTargetId({ ...raw, kind, host }),
    name: label || host,
    host,
    port: Number.isFinite(port) && port > 0 ? port : 22,
    user: String(raw.user ?? sshDefaults.user ?? '').trim(),
    channel: 'ssh',
    identityFile: expandHome(raw.identityFile ?? sshDefaults.identityFile),
    strictHostKeyChecking: raw.strictHostKeyChecking !== false,
    // 别名：如果 raw 里只有 host，config 里同名的 Host 块会被 OpenSSH 自己应用。
    sshConfigHost: String(raw.sshConfigHost ?? '').trim(),
    timeoutMs: normalizeTargetTimeout(raw.timeoutMs),
    tags: Array.isArray(raw.tags) ? raw.tags.map((t) => String(t)) : [],
    enabled: raw.enabled !== false,
    services: Array.isArray(raw.services) ? raw.services.map((s) => String(s)) : [],
  }
}

/** 从 targetsFile 读数组。文件不存在 / 解析失败一律抛错，不静默吞掉。 */
function readTargetsFile(file) {
  const resolved = expandHome(file)
  if (!resolved) return []
  let text
  try {
    text = fs.readFileSync(resolved, 'utf8')
  } catch (error) {
    throw new Error(`cannot read targetsFile ${resolved}: ${error?.message ?? error}`)
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error(`targetsFile ${resolved} is not valid JSON: ${error?.message ?? error}`)
  }
  if (Array.isArray(parsed)) return parsed
  if (parsed && Array.isArray(parsed.targets)) return parsed.targets
  throw new Error(`targetsFile ${resolved} must contain an array, or an object with a "targets" array`)
}

/**
 * 主入口：把原始 config 规范化。
 * 返回 `{ ok, config, errors }` —— 单个目标配错不应该让整个插件加载失败，
 * 所以错误被收集起来放进状态文件，面板会把它显示在错误条里。
 */
export function normalizeConfig(raw) {
  const input = raw && typeof raw === 'object' ? raw : {}
  const errors = []

  const sshDefaults = {
    user: String(input.ssh?.user ?? '').trim(),
    port: Number(input.ssh?.port ?? 22),
    identityFile: expandHome(input.ssh?.identityFile),
  }
  const commonFlags = Array.isArray(input.ssh?.commonFlags)
    ? input.ssh.commonFlags.map((f) => String(f))
    : []

  let rawTargets = Array.isArray(input.targets) ? input.targets.slice() : []
  if (input.targetsFile) {
    try {
      rawTargets = rawTargets.concat(readTargetsFile(input.targetsFile))
    } catch (error) {
      errors.push(flatten(error?.message || error, 400))
    }
  }

  const targets = []
  const seen = new Set()
  rawTargets.forEach((raw, index) => {
    try {
      const target = normalizeTarget(raw, index, sshDefaults)
      if (seen.has(target.id)) {
        errors.push(`duplicate target id "${target.id}" — skipped the later one`)
        return
      }
      seen.add(target.id)
      targets.push(target)
    } catch (error) {
      errors.push(flatten(error?.message || error, 400))
    }
  })

  const config = {
    enabled: input.enabled !== false,
    probeIntervalMs: clamp(input.probeIntervalMs ?? DEFAULT_PROBE_INTERVAL_MS, 3000, 3_600_000),
    timeoutMs: clamp(input.timeoutMs ?? DEFAULT_TIMEOUT_MS, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS),
    connectTimeoutMs: clamp(input.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS, 1000, 300_000),
    probeOnStart: input.probeOnStart !== false,
    collectDocker: input.collectDocker !== false,
    collectProcesses: input.collectProcesses !== false,
    collectServices: input.collectServices !== false,
    collectGpu: input.collectGpu !== false,
    /**
     * 写操作总闸。
     *
     * 本插件是为运维装的，所以**默认允许** docker 启停 / 服务启停 / 文件上传。
     * 但一旦设成 false，就只剩只读能力：所有改动目标机的操作都会被拒绝，
     * 并明确告诉调用方是配置拦的（而不是连不上或没权限）。
     * 注意 `/wsx exec` 与 `remote_exec` 是「执行一条命令」，无法从这个开关推断语义，
     * 所以它们**不受**这个闸门约束 —— 命令本身是否只读由调用方负责。
     */
    allowMutations: input.allowMutations !== false,
    historyLength: clamp(input.historyLength ?? DEFAULT_HISTORY_LENGTH, 0, 600),
    flushIntervalMs: clamp(input.flushIntervalMs ?? 500, 100, 60_000),
    heartbeatMs: clamp(input.heartbeatMs ?? 2000, 500, 300_000),
    maxConcurrentProbes: clamp(input.maxConcurrentProbes ?? 4, 1, 32),
    stateFile: resolveStateFile(input),
    dshHome: resolveDshHome(),
    autoLaunch: input.autoLaunch !== false,
    appPath: String(input.appPath ?? ''),
    ssh: {
      executable: String(input.ssh?.executable ?? '').trim(),
      user: sshDefaults.user,
      port: sshDefaults.port,
      identityFile: sshDefaults.identityFile,
      commonFlags,
      // 连接复用：一台机器只握手一次，后续探测走同一条 TCP 连接。
      // 实测能把热探测从 ~300ms 降到 ~80ms，也让目标机的 auth 日志安静下来。
      controlMaster: input.ssh?.controlMaster !== false,
      controlPersistSec: clamp(input.ssh?.controlPersistSec ?? 60, 0, 3600),
    },
    wsl: {
      executable: String(input.wsl?.executable ?? '').trim() || 'wsl.exe',
      defaultUser: String(input.wsl?.defaultUser ?? '').trim(),
    },
    errors,
    targets,
  }

  return { ok: errors.length === 0, config, errors }
}

/** 面板/命令里展示目标时统一用这个，省得每处都写 `name || id`。 */
export function targetLabel(target) {
  return String(target?.name || target?.id || 'target')
}

/** 可用目标清单，用于错误信息里告诉调用方「现在有哪些能选」。 */
export function listTargets(targets) {
  return (targets || []).map((t) => `${t.id} (${targetLabel(t)})`).join(', ') || '(none — add some in the plugin config)'
}

/**
 * 按选择器解析目标：**精确**匹配 id / 名称，否则取 id、名称、主机名（WSL 是发行版名）
 * 的**唯一**片段。
 *
 * 返回 `{ target }` 或 `{ target: undefined, candidates }`。这里刻意不替调用方
 * 「猜第一个」：猜错目标意味着对**另一台机器**执行操作。
 */
export function resolveTargetSelector(targets, selector) {
  const list = targets || []
  const text = String(selector ?? '').trim()
  if (!text) return { target: undefined, candidates: list }
  const lowered = text.toLowerCase()
  const exact = list.find((t) => t.id.toLowerCase() === lowered || targetLabel(t).toLowerCase() === lowered)
  if (exact) return { target: exact }
  const partial = list.filter(
    (t) =>
      t.id.toLowerCase().includes(lowered) ||
      targetLabel(t).toLowerCase().includes(lowered) ||
      String(t.host || '').toLowerCase().includes(lowered),
  )
  if (partial.length === 1) return { target: partial[0] }
  return { target: undefined, candidates: partial }
}

/**
 * 解析目标，失败时抛出一句**可操作**的错误（列出候选或全部可用目标）。
 *
 * 工具（remote_*）与命令（/wsx）共用它：以前工具走的是 manager 里那套
 * 「子串命中第一个」，而命令走这套「歧义就报错」，于是同一个选择器
 * 在两条路径上会指向不同的机器 —— `remote_exec target:"prod"` 可能悄悄
 * 打到了 prod-backup 上。选择器的语义必须只有一处。
 *
 * @param {object[]} targets 目标描述数组
 * @param {string} selector 用户给的选择器
 * @param {{missing?: string}} [options] 选择器为空时的错误文案（工具需要提醒必填）
 */
export function requireTargetSelector(targets, selector, options = {}) {
  const text = String(selector ?? '').trim()
  if (!text) {
    throw new Error(options.missing ?? `"target" is required. Configured targets: ${listTargets(targets)}`)
  }
  const { target, candidates } = resolveTargetSelector(targets, text)
  if (target) return target
  if (candidates && candidates.length > 1) {
    throw new Error(
      `${JSON.stringify(text)} matches ${candidates.length} targets: ${candidates.map((t) => t.id).join(', ')} — be more specific`,
    )
  }
  throw new Error(`no target matching ${JSON.stringify(text)}. Configured targets: ${listTargets(targets)}`)
}
