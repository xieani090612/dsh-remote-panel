/**
 * dsh-remote-panel —— 传输层
 * ============================================================================
 * 两条通道：
 *   1. `ssh` —— 通过系统 OpenSSH 客户端访问远程机器，或访问 WSL 里那个
 *      仅监听 127.0.0.1 的 sshd。**复用 ~/.ssh/config、ssh-agent 与 known_hosts**，
 *      所以使用者本来配好的免密登录直接生效。
 *   2. `wsl` —— 直接 `wsl.exe -d <distro> -- ...`。不需要 WSL 里跑 sshd，
 *      但在受限沙箱下会被 WSL 服务以 `Wsl/E_ACCESSDENIED` 拒绝（见仓库 README）。
 *
 * 为什么 spawn OpenSSH 而不是内嵌一个 JS SSH 实现：
 *   - 凭据处理直接交给系统：agent、key、passphrase 提示、FIDO key 全都不用自己实现；
 *   - 控制连接复用（ControlMaster）能把热探测压到 ~80ms；
 *   - 插件因此可以保持**零运行时依赖**，不需要打包 ssh2。
 *
 * 安全约束：本模块只负责「把一条命令送过去并取回输出」，绝不拼接 shell 元字符 ——
 * 所有动态部分都由调用方经 `shq()` 单引号转义后传入。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { effectiveTimeoutMs, targetLabel } from './config.js'
import { clamp, decodeWslOutput, flatten, runProcess } from './util.js'

/** 控制连接的 socket 目录。放在 DSH 自己的目录下，避免污染 ~/.ssh。 */
function controlDir() {
  return path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'remote-panel', 'cm')
}

/** OpenSSH 的 ControlPath 长度上限约 108 字节（含结尾 NUL），这里留足余量。 */
const MAX_CONTROL_PATH = 90

/**
 * 控制连接的 socket 路径。
 *
 * 长度限制是硬性的：OpenSSH 对 ControlPath 有 ~108 字节的上限，超了会直接拒绝
 * 建立控制连接（`ControlPath too long`），表现为**每次探测都失败**而不是变慢。
 * DSH_HOME 很深时（把它放在一个长路径的工程目录下）很容易撞上，所以这里真的
 * 检查长度，而不是只在注释里说「限制在 90 字符内」。
 *
 * 收短时必须保持**唯一**：两个目标共用一条控制连接，意味着命令可能落到
 * 另一台机器上。所以用 id 的定长哈希，而不是截断。
 */
function controlPathFor(target) {
  const dir = controlDir()
  const safe = String(target.id).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 32)
  const full = path.join(dir, `cm-${safe}`)
  if (full.length <= MAX_CONTROL_PATH) return full
  return path.join(dir, `cm-${shortHash(target.id)}`)
}

/** 定长（6 字符 base36）字符串哈希，只为让控制连接路径短而唯一。 */
function shortHash(text) {
  let hash = 2166136261
  for (const char of String(text)) {
    hash ^= char.codePointAt(0)
    hash = Math.imul(hash, 16777619) >>> 0
  }
  return hash.toString(36).padStart(6, '0')
}

/** 解析要用的 ssh 可执行文件：显式配置 > 常见位置 > PATH。 */
export function resolveSshExecutable(config) {
  const explicit = String(config?.ssh?.executable ?? '').trim()
  if (explicit) return explicit
  const candidates = [
    path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'OpenSSH', 'ssh.exe'),
    '/usr/bin/ssh',
    '/usr/local/bin/ssh',
  ]
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate
    } catch {
      /* ignore */
    }
  }
  return 'ssh'
}

/** scp 可执行文件，规则同上。 */
export function resolveScpExecutable(config) {
  const explicit = String(config?.ssh?.scpExecutable ?? '').trim()
  if (explicit) return explicit
  const candidates = [
    path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'OpenSSH', 'scp.exe'),
    '/usr/bin/scp',
    '/usr/local/bin/scp',
  ]
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate
    } catch {
      /* ignore */
    }
  }
  return 'scp'
}

/**
 * scp 的目标串 `[user@]host`（**只给 scp 用**，ssh 那条路直接把 host 当独立 argv 传，
 * 不需要也不该加方括号）。
 *
 * IPv6 字面量必须加方括号：scp 把 `host:path` 按**第一个**冒号切开，
 * 所以裸的 `::1` 会被解析成「主机名是空串」——`user@::1:/tmp/x` 直接失败。
 * 已经自带方括号的写法原样保留。
 */
export function sshDestination(target) {
  const raw = String(target.sshConfigHost || target.host || '').trim()
  const hostPart = raw.includes(':') && !raw.startsWith('[') ? `[${raw}]` : raw
  return target.user ? `${target.user}@${hostPart}` : hostPart
}

/**
 * 构造 ssh 参数数组。
 *
 * 关键设计：把 `-o` 选项显式写全，而不是依赖使用者的 ~/.ssh/config。
 *  - `BatchMode=yes` 保证**永不弹密码提示**：密码提示会挂在没有 TTY 的子进程上，
 *    表现为「探测永远超时」。想用密码就走 agent 或密钥。
 *  - `StrictHostKeyChecking=no` 仅在配置显式关闭时使用（默认保持严格）。
 */
export function buildSshArgs(target, config, remoteCommand, options = {}) {
  const args = []
  args.push('-o', `ConnectTimeout=${Math.ceil(clamp(config.connectTimeoutMs, 1000, 300_000) / 1000)}`)
  args.push('-o', 'BatchMode=yes')
  args.push('-o', 'NumberOfPasswordPrompts=0')
  args.push('-o', 'ServerAliveInterval=15')
  args.push('-o', 'ServerAliveCountMax=3')
  if (target.strictHostKeyChecking === false) {
    args.push('-o', 'StrictHostKeyChecking=no')
    args.push('-o', 'UserKnownHostsFile=/dev/null')
  }
  if (config.ssh?.controlMaster && !options.noControlMaster) {
    const socket = controlPathFor(target)
    // 路径太长时 ssh 会直接拒绝建立控制连接（`ControlPath too long`），
    // 那是**每次探测都失败**，比「不复用连接、每次多花几百毫秒」糟得多。
    // 所以这里宁可放弃复用：DSH_HOME 被放在一条很深的路径下时真的会撞上。
    if (socket.length <= MAX_CONTROL_PATH) {
      args.push('-o', 'ControlMaster=auto')
      args.push('-o', `ControlPath=${socket}`)
      args.push('-o', `ControlPersist=${config.ssh.controlPersistSec}`)
    }
  }
  if (target.identityFile) args.push('-i', target.identityFile)
  if (target.port && target.port !== 22) args.push('-p', String(target.port))
  for (const flag of config.ssh?.commonFlags ?? []) args.push(flag)
  args.push('--')
  args.push(target.sshConfigHost || target.host)
  if (remoteCommand !== undefined && remoteCommand !== null) args.push(remoteCommand)
  return args
}

/**
 * 在远程执行一条命令。
 *
 * @returns {Promise<{ok: boolean, stdout: string, stderr: string, code: number|null, ms: number, timedOut: boolean, channel: 'ssh'|'wsl', error?: string, woke?: boolean}>}
 */
export async function runOverSsh(target, config, remoteCommand, options = {}) {
  const ssh = resolveSshExecutable(config)
  const timeoutMs = options.timeoutMs ?? effectiveTimeoutMs(target, config)
  const args = buildSshArgs(target, config, remoteCommand, options)

  const result = await runProcess(ssh, args, { timeoutMs })
  if (result.timedOut) {
    return {
      ...result,
      ok: false,
      channel: 'ssh',
      error:
        `timed out after ${Math.round(timeoutMs / 1000)}s waiting for ${sshDestination(target)}:${target.port || 22} ` +
        `(${targetLabel(target)}) — is sshd reachable, is key auth working, and is the target responsive? ` +
        'Raise this target\'s timeoutMs if it is simply slow.',
    }
  }
  if (result.error) {
    return { ...result, ok: false, channel: 'ssh', error: `cannot run ssh: ${result.error}` }
  }
  if (result.code !== 0) {
    const detail = flatten(result.stderr || result.stdout, 400)
    return {
      ...result,
      ok: false,
      channel: 'ssh',
      error: detail || `ssh exited with code ${result.code}`,
    }
  }
  return { ...result, ok: true, channel: 'ssh' }
}

/**
 * 通过 wsl.exe 执行。
 *
 * 两个必须记住的坑（都实测踩过）：
 *
 * 1. **绝不能把脚本当 `sh -c` 的参数传。** Windows 的 `wsl.exe` 在把命令行
 *    交给发行版之前会经过一次 Windows 侧的解析，`$1` `$2` `$3` 这类位置参数会被
 *    吃掉，远程 awk/sed 脚本于是收到空字段（表现为 `awk: syntax error`）。
 *    改成把脚本写到 **stdin**、远程用 `sh -s` 读，就完全绕开了这条路。
 *
 * 2. **不能用登录 shell（`sh -lc`）。** Ubuntu 的 root 登录会 source
 *    `/etc/profile` 及其 `.d` 目录，其中一些脚本会去读 **stdin**；而我们的脚本
 *    如果走 stdin，就会被它们抢先消费掉，结果是「前半段勉强跑通、后半段全空」。
 *    实测 `sh -lc` 会让 5121 字节的脚本只产出 279 字节输出。
 *
 * 所以最终形态是：`wsl.exe -d <distro> -u <user> -- sh -s`，脚本经 stdin 送入。
 * 这样既没有位置参数被吃的问题，也没有 profile 抢 stdin 的问题。
 */
export async function runOverWsl(target, config, remoteCommand, options = {}) {
  const exe = config.wsl?.executable || 'wsl.exe'
  const args = ['-d', target.distro]
  const user = target.user || config.wsl?.defaultUser
  if (user) args.push('-u', user)
  args.push('--', 'sh', '-s')

  const timeoutMs = options.timeoutMs ?? effectiveTimeoutMs(target, config)
  const result = await runProcess(exe, args, {
    timeoutMs,
    input: String(remoteCommand ?? ''),
    env: { WSL_UTF8: '1' },
  })

  const stdout = decodeWslOutput(result.stdout)
  const stderr = decodeWslOutput(result.stderr)

  if (result.timedOut) {
    return {
      ...result,
      stdout,
      stderr,
      ok: false,
      channel: 'wsl',
      error: `wsl.exe timed out after ${Math.round(timeoutMs / 1000)}s (a cold WSL start can take 18-88s; try raising timeoutMs, or use channel: "ssh")`,
    }
  }
  if (/E_ACCESSDENIED|Wsl\/E_|Access is denied/i.test(`${stdout}${stderr}`)) {
    return {
      ...result,
      stdout,
      stderr,
      ok: false,
      channel: 'wsl',
      error:
        'wsl.exe was refused by the WSL service (Wsl/E_ACCESSDENIED). This happens under a restricted DSH sandbox with no full access. Use channel: "ssh" with the wsl-link sshd on 127.0.0.1:2222 instead.',
    }
  }
  if (result.error) {
    return { ...result, stdout, stderr, ok: false, channel: 'wsl', error: `cannot run wsl.exe: ${result.error}` }
  }
  if (result.code !== 0) {
    const detail = flatten(stderr || stdout, 400)
    return { ...result, stdout, stderr, ok: false, channel: 'wsl', error: detail || `wsl.exe exited with code ${result.code}` }
  }
  return { ...result, stdout, stderr, ok: true, channel: 'wsl' }
}

/**
 * 统一的执行入口：按 target.kind / target.channel 选择通道。
 *
 * `channel: "auto"` 的 WSL 目标是「先 SSH 再 wsl.exe」：
 * 本机 WSL 上通常没有 sshd，但一旦用 wsl-link 那套装过，SSH 就明显更快
 * （不受沙箱限制、也不需要冷启动整个发行版）。
 */
export async function runRemote(target, config, remoteCommand, options = {}) {
  if (target.kind === 'ssh') {
    return runOverSsh(target, config, remoteCommand, options)
  }

  const channel = target.channel || 'auto'
  if (channel === 'wsl') return runOverWsl(target, config, remoteCommand, options)
  if (channel === 'ssh') return runOverSsh(target, config, remoteCommand, options)

  // auto
  const viaSsh = await runOverSsh(target, config, remoteCommand, options)
  if (viaSsh.ok) return viaSsh
  const viaWsl = await runOverWsl(target, config, remoteCommand, options)
  if (viaWsl.ok) return viaWsl
  // 两条都失败：报 SSH 的错（通常更有信息量 —— 端口不可达 vs 沙箱拒绝）。
  return {
    ...viaSsh,
    error: `${viaSsh.error} || wsl.exe fallback: ${viaWsl.error}`,
  }
}

/** 探测目标是否可达：跑一条几乎零成本、且所有 POSIX 系统都有的命令。 */
export async function probeConnectivity(target, config, options = {}) {
  const startedAt = Date.now()
  const result = await runRemote(target, config, 'echo __wsx_ok__', {
    ...options,
    timeoutMs: options.timeoutMs ?? Math.min(effectiveTimeoutMs(target, config), config.connectTimeoutMs * 2),
  })
  const ok = result.ok && /__wsx_ok__/.test(result.stdout)
  return {
    ok,
    channel: result.channel,
    latencyMs: Date.now() - startedAt,
    error: ok ? undefined : result.error || 'unexpected reply from target',
  }
}

/** 清理控制连接。插件卸载时调用，避免留下悬空的 master 进程。 */
export async function closeControlConnections(targets, config) {
  const ssh = resolveSshExecutable(config)
  const results = []
  for (const target of targets) {
    const socket = controlPathFor(target)
    try {
      if (!fs.existsSync(socket)) continue
    } catch {
      continue
    }
    const args = ['-o', `ControlPath=${socket}`, '-O', 'exit', '--', target.sshConfigHost || target.host]
    const result = await runProcess(ssh, args, { timeoutMs: 5000 })
    results.push({ id: target.id, ok: result.ok })
  }
  return results
}

export { controlPathFor, controlDir }
