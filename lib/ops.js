/**
 * dsh-remote-panel —— 运维操作
 * ============================================================================
 * 五类操作，全部叠在同一个传输层之上：
 *   status    只读采集（由 manager 直接调用 probe）
 *   files     上传 / 下载 / 列目录 / 读文件（scp + 远程 ls/cat）
 *   docker    列表 / 启停 / 重启 / 日志
 *   process   列表 / 结束
 *   service   状态 / 启停 / 重启（systemd 或 service 回退）
 *
 * 安全模型（重要）：
 *   1. **动状态的操作用 `allowMutations` 总闸**。默认 true（本插件是为运维装的），
 *      但设成 false 时只读操作照常，写操作一律被拒并说明原因。
 *   2. **结束进程另有一道闸**：必须显式给出 `confirm: true`。因为「按 PID 杀进程」
 *      是本插件里唯一一个参数一写错就能搞垮目标机的操作。
 *   3. **所有拼进远程命令的字符串都经 shq() 单引号转义**，没有任何一处拼接裸变量。
 *   4. 服务名 / 进程名 / 容器名做字符白名单校验，违者直接拒绝而不是转义后放行 ——
 *      这类名字本来就不该含空格或元字符，放行只会掩盖上游的 bug。
 */

import fs from 'node:fs'
import path from 'node:path'
import { effectiveTimeoutMs, expandHome } from './config.js'
import { flatten, runProcess, shq, writeFileAtomicSync } from './util.js'
import { resolveScpExecutable, runRemote, sshDestination } from './ssh.js'

/** 容器/服务/镜像名：Docker 与 systemd 允许的字符集，刻意收窄。 */
const SAFE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,127}$/
/** 日志行数上限，避免一条命令拉回几百 MB。 */
const MAX_LOG_LINES = 5000
/** 远程列目录条数上限。 */
const MAX_LIST_ENTRIES = 2000
/**
 * base64 内联回退的字节上限。
 *
 * 为什么必须有这个上限 —— 这是两个不同的坑：
 *   - **上传**：文件要被读进内存再 base64（体积 ×4/3），还要拼进一条命令字符串，
 *     所以峰值内存约 2.7 倍文件大小；以前的上限是 48MB，也就是一次上传可能吃掉
 *     DSH 宿主几百 MB 内存。
 *   - **下载**：base64 要从 stdout 原路返回，而 runProcess 对 stdout 有上限保护，
 *     超限时**只保留尾部**。于是「下载一个 10MB 的文件、解码尾部、写进本地文件」
 *     会静默产出一个损坏的文件。所以上传/下载都必须先知道大小、并且在这里拒绝。
 */
const MAX_INLINE_BYTES = 8 * 1024 * 1024
/** base64 内联下载时给 stdout 的上限（= 上限的 4/3 再加一点换行/余量）。 */
const INLINE_STDOUT_BYTES = Math.ceil((MAX_INLINE_BYTES * 4) / 3) + 65_536

/**
 * 内联（base64）回退的准入判断：超限时返回一句能直接展示的理由，否则 undefined。
 * 上传与下载共用这一处，避免一边收紧、另一边漏掉。
 */
export function inlineLimitError(bytes, max = MAX_INLINE_BYTES) {
  const size = Number(bytes)
  if (!Number.isFinite(size) || size <= max) return undefined
  return `${size} bytes is over the ${Math.round(max / 1024 / 1024)}MB inline limit`
}

export class MutationNotAllowedError extends Error {
  constructor(operation) {
    super(
      `refusing "${operation}": this plugin is configured with allowMutations=false, so only read-only operations are permitted. ` +
        'Set allowMutations: true in the plugin config (row dsh-remote-panel in cordis.patch.yml) to enable it.',
    )
    this.name = 'MutationNotAllowedError'
  }
}

function assertSafeName(value, what) {
  const text = String(value ?? '').trim()
  if (!text) throw new Error(`${what} is required`)
  if (!SAFE_NAME_RE.test(text)) {
    throw new Error(`${what} ${JSON.stringify(value)} is not a valid name (allowed: letters, digits, and . _ - : @)`)
  }
  return text
}

function assertMutationAllowed(config, operation) {
  if (config?.allowMutations === false) throw new MutationNotAllowedError(operation)
}

// ---------------------------------------------------------------------------
// 文件
// ---------------------------------------------------------------------------

/** 校验远程路径：必须是绝对路径，避免相对路径在不同 cwd 下落错地方。 */
function assertRemotePath(value, what) {
  const text = String(value ?? '').trim()
  if (!text) throw new Error(`${what} is required`)
  if (!text.startsWith('/')) {
    throw new Error(`${what} must be an absolute POSIX path (got ${JSON.stringify(text)})`)
  }
  if (text.includes('\u0000')) throw new Error(`${what} contains a NUL byte`)
  return text
}

/**
 * `ls -lan` 的一行 → 结构化条目；解析不出来就返回 undefined。
 * （`total 12` 那行、以及设备文件的 `major, minor` 列都会走到这里被丢掉。）
 */
export function parseLsLine(line) {
  const match = /^([dlbcps-])[rwxsStT-]{9}\s+(\d+)\s+(\S+)\s+(\S+)\s+(\d+)\s+(\S+\s+\S+\s+\S+)\s+(.*)$/.exec(
    String(line ?? '').trim(),
  )
  if (!match) return undefined
  const [, typeChar, , owner, group, size, , rawName] = match
  if (rawName === '.' || rawName === '..') return undefined
  // 符号链接会带 " -> target"，单独拆出来。
  const arrow = rawName.indexOf(' -> ')
  return {
    name: arrow >= 0 ? rawName.slice(0, arrow) : rawName,
    type: typeChar === 'd' ? 'dir' : typeChar === 'l' ? 'link' : typeChar === '-' ? 'file' : 'other',
    sizeBytes: Number(size) || 0,
    owner,
    group,
    linkTarget: arrow >= 0 ? rawName.slice(arrow + 4) : undefined,
  }
}

/**
 * 解析 `ls -lan` 的输出。
 *
 * 抽成纯函数是因为 `truncated` 以前算错过：它拿「解析后的条数」跟上限比，
 * 而 `.` 与 `..` 是在解析之后被过滤掉的 —— 于是**刚好被截断时反而报
 * truncated=false**（少算 2 条）。现在按「拿到的行数」判断，语义明确。
 */
export function parseLsOutput(stdout, limit = MAX_LIST_ENTRIES) {
  const entries = []
  for (const line of String(stdout ?? '').split(/\r?\n/)) {
    const entry = parseLsLine(line)
    if (entry) entries.push(entry)
  }
  const truncated = entries.length > limit
  return { entries: truncated ? entries.slice(0, limit) : entries, truncated }
}

/** 列出远程目录。用 `ls -la` 的稳定列序，不依赖 `find -printf`（busybox 没有）。 */
export async function listRemoteDirectory(target, config, remoteDir) {
  const dir = assertRemotePath(remoteDir, 'path')
  // 多要 4 行：ls -lan 的第一行是 `total N`，接着是 `.` 与 `..`（都会被丢掉），
  // 所以想确认「是不是还有更多条目」必须多取几行，否则刚好满一屏时报不出截断。
  const command = [
    `if [ ! -d ${shq(dir)} ]; then echo '__wsx_err__ not a directory'; exit 3; fi`,
    `ls -lan ${shq(dir)} 2>/dev/null | head -n ${MAX_LIST_ENTRIES + 4}`,
  ].join('\n')
  const result = await runRemote(target, config, command)
  if (!result.ok) {
    throw new Error(`${target.name}: ${result.error || `ls exited with code ${result.code}`}`)
  }
  const parsed = parseLsOutput(result.stdout, MAX_LIST_ENTRIES)
  return { path: dir, entries: parsed.entries, truncated: parsed.truncated }
}

/** 读远程文本文件（有大小上限，避免把日志整份拉回来）。 */
export async function readRemoteFile(target, config, remotePath, maxBytes = 262_144) {
  const file = assertRemotePath(remotePath, 'path')
  const limit = Math.max(1, Math.min(Number(maxBytes) || 262_144, 4_194_304))
  const command = [
    `if [ ! -f ${shq(file)} ]; then echo '__wsx_err__ not a regular file' >&2; exit 3; fi`,
    `wc -c < ${shq(file)} 2>/dev/null`,
    `head -c ${limit} ${shq(file)} 2>/dev/null`,
  ].join('\n')
  const result = await runRemote(target, config, command)
  if (!result.ok) {
    throw new Error(`${target.name}: ${result.error || `read exited with code ${result.code}`}`)
  }
  const newline = result.stdout.indexOf('\n')
  const sizeText = newline >= 0 ? result.stdout.slice(0, newline).trim() : ''
  const totalBytes = Number(sizeText)
  const content = newline >= 0 ? result.stdout.slice(newline + 1) : ''
  const known = Number.isFinite(totalBytes)
  return {
    path: file,
    content,
    totalBytes: known ? totalBytes : undefined,
    // 跟**字节上限**比，而不是跟「解码后重新编码的长度」比：head -c 可能把一个
    // 多字节字符切成两半，解码成 U+FFFD 后重新编码会变长，于是截断被报成没截断。
    truncated: known ? totalBytes > limit : undefined,
  }
}

/**
 * 上传回退用的远程命令：base64 经 stdin 送过去。
 *
 * 三个必须记住的点：
 *  1. **先写临时文件、校验字节数、再 `mv -f` 替换**。直接 `base64 -d > 目标`
 *     会先把目标截断，中途失败（管道断、磁盘满、base64 解码出错）就留下一个
 *     半截或空文件 —— 而调用方看到的是「失败」，本地那份好文件已经被摧毁了。
 *  2. 分隔符 `__WSX_B64__` 里带下划线，而 base64 字母表只有 A–Za–z0–9+/=，
 *     所以分隔符**不可能**在载荷里出现。
 *  3. chmod 在 mv 之前做，文件一出现就是最终权限。
 */
export function buildInlineUploadCommand({ remote, tmp, encoded, bytes, mode, makeDirs }) {
  const sizeCheck =
    `[ "$(wc -c < ${shq(tmp)} | tr -d ' ')" = ${shq(String(bytes))} ] || ` +
    `{ echo "__wsx_upload_incomplete__ expected ${bytes} bytes, got $(wc -c < ${shq(tmp)} | tr -d ' ')" >&2; ` +
    `rm -f ${shq(tmp)}; exit 4; }`
  return [
    'umask 022',
    makeDirs ? `mkdir -p ${shq(path.posix.dirname(remote))}` : 'true',
    `base64 -d > ${shq(tmp)} <<'__WSX_B64__'\n${encoded}\n__WSX_B64__`,
    sizeCheck,
    mode ? `chmod ${shq(String(mode))} ${shq(tmp)}` : 'true',
    `mv -f ${shq(tmp)} ${shq(remote)}`,
    'echo __wsx_uploaded__',
  ].join('\n')
}

/**
 * 下载回退用的远程命令：先 `wc -c` 报大小，再 base64 输出正文。
 * 大小是**先**拿到的，所以本地能在解码之前就拒绝过大的文件 —— 而不是
 * 拿到一份被 stdout 上限截断的尾部、静默写坏本地文件。
 */
export function buildInlineDownloadCommand(remote) {
  return [`wc -c < ${shq(remote)} 2>/dev/null`, `base64 ${shq(remote)} 2>/dev/null`].join('\n')
}

/**
 * 上传：优先 scp（走 OpenSSH，天然复用 ssh-agent 与 config），
 * scp 不可用时回退到「base64 经 stdin 送过去」的纯 POSIX 路径。
 */
export async function uploadFile(target, config, { localPath, remotePath, makeDirs = false, mode }) {
  const local = expandHome(localPath)
  if (!local) throw new Error('localPath is required')
  let stat
  try {
    stat = fs.statSync(local)
  } catch (error) {
    throw new Error(`cannot read local file ${local}: ${error?.message ?? error}`)
  }
  if (!stat.isFile()) throw new Error(`localPath ${local} is not a regular file`)
  const remote = assertRemotePath(remotePath, 'remotePath')

  const startedAt = Date.now()
  const warnings = []
  let via = 'scp'
  let result

  // ---- 首选 scp ----
  const scp = resolveScpExecutable(config)
  const scpArgs = []
  scpArgs.push('-o', 'BatchMode=yes')
  scpArgs.push('-o', `ConnectTimeout=${Math.ceil(config.connectTimeoutMs / 1000)}`)
  if (target.strictHostKeyChecking === false) {
    scpArgs.push('-o', 'StrictHostKeyChecking=no')
    scpArgs.push('-o', 'UserKnownHostsFile=/dev/null')
  }
  if (target.identityFile) scpArgs.push('-i', target.identityFile)
  // scp 的端口参数是大写 -P，和 ssh 的 -p 不同。
  if (target.port && target.port !== 22) scpArgs.push('-P', String(target.port))
  scpArgs.push('--', local, `${sshDestination(target)}:${remote}`)

  result = await runProcess(scp, scpArgs, { timeoutMs: effectiveTimeoutMs(target, config) })
  let scpError = result.ok ? '' : result.error || `exit ${result.code}`

  // scp 传不过去（例如目标机没有 sftp-server）时回退到 base64 over ssh。
  if (!result.ok) {
    const tooBig = inlineLimitError(stat.size)
    if (tooBig) {
      throw new Error(
        `${target.name}: scp failed (${scpError}) and ${local} ${tooBig} — the base64 fallback would have to hold it ` +
          'in memory. Fix sftp-server / scp on the target, or split the file.',
      )
    }
    const encoded = fs.readFileSync(local).toString('base64')
    const command = buildInlineUploadCommand({
      remote,
      // 临时文件放在目标同目录，`mv -f` 才是同文件系统内的原子替换。
      tmp: `${remote}.wsx-${process.pid}.part`,
      encoded,
      bytes: stat.size,
      mode,
      makeDirs,
    })
    const uploaded = await runRemote(target, config, command, {
      timeoutMs: Math.max(effectiveTimeoutMs(target, config), 120_000),
    })
    if (uploaded.ok && /__wsx_uploaded__/.test(uploaded.stdout)) {
      via = 'base64'
      result = uploaded
    } else {
      // 回退也失败时，把两条通道的原因都留着 —— 只报 scp 的错会让人
      // 去修一个可能不是主因的东西。（注意这里必须**抛**：`uploaded.ok` 为真
      // 但缺少完成标记也属于失败，不能靠后面的 `result.ok` 判断。）
      const detail = uploaded.error || flatten(uploaded.stderr || uploaded.stdout, 200) || `exit ${uploaded.code}`
      throw new Error(`${target.name}: upload failed (scp: ${scpError}; base64: ${detail})`)
    }
  }

  if (!result.ok) {
    throw new Error(`${target.name}: upload failed (${scpError})`)
  }

  // scp 成功时 mode 还没生效，补一次；失败要**说出来**，
  // 以前这一句的结果被直接丢掉，于是「上传成功但权限没改」看起来一切正常。
  // （makeDirs 不需要补：scp 能写进去就说明目录已经存在。）
  if (via === 'scp' && mode) {
    const chmod = await runRemote(target, config, `chmod ${shq(String(mode))} ${shq(remote)}`)
    if (!chmod.ok) {
      warnings.push(
        `mode ${mode} was not applied: ${flatten(chmod.stderr || chmod.error, 200) || `chmod exited with code ${chmod.code}`} (the file itself was uploaded)`,
      )
    }
  }

  return {
    localPath: local,
    remotePath: remote,
    bytes: stat.size,
    via,
    durationMs: Date.now() - startedAt,
    warnings: warnings.length ? warnings : undefined,
  }
}

/** 下载：scp，失败同样回退到「远程 base64 + 本地解码」。 */
export async function downloadFile(target, config, { remotePath, localPath, overwrite = false, createDirs = true }) {
  const remote = assertRemotePath(remotePath, 'remotePath')
  const local = expandHome(localPath)
  if (!local) throw new Error('localPath is required')

  if (createDirs) fs.mkdirSync(path.dirname(local), { recursive: true })
  if (!overwrite && fs.existsSync(local)) {
    throw new Error(`local file ${local} already exists — pass overwrite: true to replace it`)
  }

  const startedAt = Date.now()
  const scp = resolveScpExecutable(config)
  const scpArgs = ['-o', 'BatchMode=yes', '-o', `ConnectTimeout=${Math.ceil(config.connectTimeoutMs / 1000)}`]
  if (target.strictHostKeyChecking === false) {
    scpArgs.push('-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=/dev/null')
  }
  if (target.identityFile) scpArgs.push('-i', target.identityFile)
  if (target.port && target.port !== 22) scpArgs.push('-P', String(target.port))
  scpArgs.push('--', `${sshDestination(target)}:${remote}`, local)

  const result = await runProcess(scp, scpArgs, { timeoutMs: effectiveTimeoutMs(target, config) })
  let via = 'scp'
  let bytes = 0

  if (result.ok) {
    bytes = fs.statSync(local).size
  } else {
    // 回退：远程 base64，本地解码写盘。先拿 `wc -c` 的结果做**大小与完整性**校验 ——
    // 这句注释以前就在，但代码里根本没有 wc -c，于是大于 stdout 上限的文件会被
    // 悄悄截断成「尾部」，解码后写进本地文件，调用方却看到成功。
    const grabbed = await runRemote(target, config, buildInlineDownloadCommand(remote), {
      timeoutMs: Math.max(effectiveTimeoutMs(target, config), 120_000),
      // 这条通道的 stdout 就是文件本体，所以要显式放宽上限（默认 8MB）。
      maxStdoutBytes: INLINE_STDOUT_BYTES,
    })
    if (!grabbed.ok) {
      throw new Error(
        `${target.name}: download failed (scp: ${result.error || `exit ${result.code}`}; base64: ${grabbed.error || `exit ${grabbed.code}`})`,
      )
    }
    const newline = grabbed.stdout.indexOf('\n')
    const expected = Number(newline >= 0 ? grabbed.stdout.slice(0, newline).trim() : NaN)
    if (!Number.isFinite(expected)) {
      throw new Error(
        `${target.name}: the base64 fallback could not read the size of ${remote} — does the path exist and is it readable?`,
      )
    }
    const tooBig = inlineLimitError(expected)
    if (tooBig) {
      throw new Error(
        `${target.name}: ${remote} ${tooBig} (scp failed: ${result.error || `exit ${result.code}`}) — ` +
          'the local file was left untouched. Fix sftp-server / scp on the target to fetch larger files.',
      )
    }
    // base64 输出可能被 coreutils 按 76 列折行，先把空白去掉再解码。
    const decoded = Buffer.from(grabbed.stdout.slice(newline + 1).replace(/\s+/g, ''), 'base64')
    if (decoded.length !== expected) {
      throw new Error(
        `${target.name}: the base64 fallback returned ${decoded.length} bytes but ${remote} is ${expected} bytes — ` +
          'refusing to write a truncated file over the local copy.',
      )
    }
    writeFileAtomicSync(local, decoded)
    bytes = decoded.length
    via = 'base64'
  }

  return { remotePath: remote, localPath: local, bytes, via, durationMs: Date.now() - startedAt }
}

// ---------------------------------------------------------------------------
// Docker
// ---------------------------------------------------------------------------

const DOCKER_FORMAT = '{{.ID}}|{{.Names}}|{{.Image}}|{{.State}}|{{.Status}}'

export async function dockerPs(target, config, { all = true, limit = 50 } = {}) {
  const count = Math.max(1, Math.min(Number(limit) || 50, 500))
  const command = [
    'command -v docker >/dev/null 2>&1 || { echo __wsx_no_docker__; exit 0; }',
    `docker ps ${all ? '-a' : ''} --format ${shq(DOCKER_FORMAT)} 2>&1 | head -n ${count}`,
  ].join('\n')
  const result = await runRemote(target, config, command)
  if (!result.ok) {
    throw new Error(`${target.name}: ${result.error || `docker ps exited with code ${result.code}`}`)
  }
  if (result.stdout.includes('__wsx_no_docker__')) {
    return { available: false, containers: [] }
  }
  const containers = []
  for (const line of result.stdout.split(/\r?\n/)) {
    const parts = line.split('|')
    if (parts.length < 5) {
      // 不是容器行 —— 通常是 docker 的权限报错，原样带回给调用方看。
      if (line.trim() && /permission denied|cannot connect/i.test(line)) {
        return { available: true, containers: [], error: line.trim() }
      }
      continue
    }
    containers.push({
      id: parts[0],
      name: parts[1],
      image: parts[2],
      state: parts[3],
      status: parts[4],
    })
  }
  return { available: true, containers }
}

const DOCKER_ACTIONS = new Set(['start', 'stop', 'restart', 'pause', 'unpause'])

export async function dockerAction(target, config, { container, action, timeoutSec }) {
  assertMutationAllowed(config, `docker ${action}`)
  const name = assertSafeName(container, 'container')
  const verb = String(action ?? '').trim().toLowerCase()
  if (!DOCKER_ACTIONS.has(verb)) {
    throw new Error(`action must be one of ${[...DOCKER_ACTIONS].join(', ')} (got ${JSON.stringify(action)})`)
  }
  const timeout = Number.isFinite(Number(timeoutSec)) ? ` -t ${Math.max(0, Math.floor(Number(timeoutSec)))}` : ''
  const result = await runRemote(target, config, `docker ${verb}${timeout} ${shq(name)} 2>&1`, {
    timeoutMs: Math.max(effectiveTimeoutMs(target, config), 60_000),
  })
  const output = (result.stdout || result.stderr || '').trim()
  if (!result.ok) {
    throw new Error(`${target.name}: docker ${verb} ${name} failed: ${output || result.error}`)
  }
  return { container: name, action: verb, output: output || name }
}

/**
 * 把一段文本按行裁到最多 count 行，并说明是不是真的被裁了。
 *
 * 抽成纯函数是因为 `truncated` 以前算的是「行数 >= count」—— 一个正好有
 * count 行日志的容器会被报成「已截断」，而多要一行的做法才是准确的。
 */
export function windowTail(text, count) {
  const lines = String(text ?? '').split(/\r?\n/)
  // 末尾的换行会产生一个空串，不算一行内容。
  if (lines.length && lines[lines.length - 1] === '') lines.pop()
  const truncated = lines.length > count
  return { lines: truncated ? lines.slice(-count) : lines, truncated }
}

export async function dockerLogs(target, config, { container, lines = 100, since }) {
  const name = assertSafeName(container, 'container')
  const count = Math.max(1, Math.min(Number(lines) || 100, MAX_LOG_LINES))
  const sinceFlag = since ? ` --since ${shq(String(since))}` : ''
  // 多要一行：只有拿到了 count+1 行才能确定「上面还有」。
  const result = await runRemote(target, config, `docker logs --tail ${count + 1}${sinceFlag} ${shq(name)} 2>&1`, {
    timeoutMs: Math.max(effectiveTimeoutMs(target, config), 60_000),
  })
  // 失败时**抛错**，和其它操作一致。以前它把错误塞在 data.error 里当成成功返回，
  // 于是「容器不存在」在调用方看来是「成功拿到 0 行日志」。
  if (!result.ok) {
    const detail = flatten(result.stderr || result.stdout || result.error, 300)
    throw new Error(
      `${target.name}: docker logs ${name} failed: ${detail || `exit ${result.code}`}` +
        ' — check the container name with docker ps, and that the SSH user can reach /var/run/docker.sock.',
    )
  }
  const window = windowTail(result.stdout, count)
  return {
    container: name,
    lines: count,
    output: window.lines.join('\n'),
    truncated: window.truncated,
  }
}

// ---------------------------------------------------------------------------
// 进程
// ---------------------------------------------------------------------------

export async function listProcesses(target, config, { sort = 'cpu', limit = 15, filter } = {}) {
  const count = Math.max(1, Math.min(Number(limit) || 15, 200))
  const key = sort === 'mem' ? '-pmem' : '-pcpu'
  // 过滤器用于 `pgrep` 风格的匹配，用 -f 匹配整条命令行。
  const grep = filter ? ` | grep -i -- ${shq(String(filter))}` : ''
  const command =
    `ps -eo pid=,user=,pcpu=,pmem=,etime=,args= --sort=${key} 2>/dev/null${grep} | head -n ${count}`
  const result = await runRemote(target, config, command)
  if (!result.ok) {
    throw new Error(`${target.name}: ${result.error || `ps exited with code ${result.code}`}`)
  }
  const processes = []
  for (const line of result.stdout.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(\S+)\s+([\d.]+)\s+([\d.]+)\s+(\S+)\s+(.*)$/.exec(line)
    if (!match) continue
    processes.push({
      pid: Number(match[1]),
      user: match[2],
      cpuPercent: Number(match[3]),
      memPercent: Number(match[4]),
      elapsed: match[5],
      command: match[6].trim(),
    })
  }
  return { sort: key === '-pmem' ? 'mem' : 'cpu', filter: filter || undefined, processes }
}

/**
 * 结束进程。
 *
 * 这是本插件里唯一一个「参数写错就能搞垮目标机」的操作，所以额外要求
 * 调用方显式给 `confirm: true` —— 一道独立于 allowMutations 的闸。
 */
export async function killProcess(target, config, { pid, signal = 'TERM', confirm }) {
  assertMutationAllowed(config, 'process kill')
  if (confirm !== true) {
    throw new Error(
      'kill_process requires "confirm": true. Killing by PID is irreversible on the target — pass confirm: true only after verifying the PID identifies the intended process.',
    )
  }
  const numericPid = Number(pid)
  if (!Number.isInteger(numericPid) || numericPid <= 0 || numericPid > 4_194_304) {
    throw new Error(`pid must be a positive integer (got ${JSON.stringify(pid)})`)
  }
  if (numericPid === 1) {
    throw new Error('refusing to signal PID 1 — that would take the whole target down')
  }
  const sig = String(signal ?? 'TERM').trim().toUpperCase().replace(/^SIG/, '')
  if (!/^[A-Z0-9]{2,10}$/.test(sig)) {
    throw new Error(`signal ${JSON.stringify(signal)} is not valid`)
  }
  // 先用 ps 确认这个 PID 存在并回显它是什么，避免「杀了想杀之外的东西」还说不清。
  const before = await runRemote(target, config, `ps -p ${numericPid} -o pid=,user=,args= 2>/dev/null`)
  const identity = before.stdout.trim()
  if (!identity) {
    return { pid: numericPid, signal: sig, killed: false, reason: 'no such process' }
  }
  const result = await runRemote(target, config, `kill -${sig} ${numericPid} 2>&1`, { timeoutMs: 15_000 })
  return {
    pid: numericPid,
    signal: sig,
    identity,
    killed: result.ok,
    error: result.ok ? undefined : (result.stderr || result.stdout || result.error || '').trim(),
  }
}

// ---------------------------------------------------------------------------
// 服务（systemd 优先，`service` 回退）
// ---------------------------------------------------------------------------

const SERVICE_ACTIONS = new Set(['start', 'stop', 'restart', 'reload'])

export async function serviceStatus(target, config, { services = [] } = {}) {
  const names = (services.length ? services : ['ssh', 'sshd', 'docker', 'cron', 'nginx']).map((s) =>
    assertSafeName(s, 'service name'),
  )
  const quoted = names.map((n) => shq(n)).join(' ')
  const command = [
    'if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then',
    `  for s in ${quoted}; do`,
    '    state=$(systemctl is-active "$s" 2>/dev/null || echo unknown)',
    '    sub=$(systemctl show -p SubState --value "$s" 2>/dev/null || echo "")',
    '    echo "svc|$s|$state|$sub"',
    '  done',
    '  echo "runner|systemctl"',
    'else',
    `  for s in ${quoted}; do`,
    '    if [ -x "/etc/init.d/$s" ]; then',
    '      state=$(/etc/init.d/$s status >/dev/null 2>&1 && echo active || echo inactive)',
    '    else',
    '      state=unknown',
    '    fi',
    '    echo "svc|$s|$state|"',
    '  done',
    '  echo "runner|sysvinit"',
    'fi',
  ].join('\n')
  const result = await runRemote(target, config, command)
  if (!result.ok) {
    throw new Error(`${target.name}: ${result.error || `status exited with code ${result.code}`}`)
  }
  let runner = 'unknown'
  const list = []
  for (const line of result.stdout.split(/\r?\n/)) {
    const parts = line.split('|')
    if (parts[0] === 'runner') runner = parts[1] || 'unknown'
    else if (parts[0] === 'svc') list.push({ name: parts[1], active: parts[2], sub: parts[3] || undefined })
  }
  return { runner, services: list }
}

export async function serviceAction(target, config, { service, action }) {
  assertMutationAllowed(config, `service ${action}`)
  // 先校验 action：它拼错时，报「service 名字非法」会误导调用方去查名字。
  const verb = String(action ?? '').trim().toLowerCase()
  if (!SERVICE_ACTIONS.has(verb)) {
    throw new Error(`action must be one of ${[...SERVICE_ACTIONS].join(', ')} (got ${JSON.stringify(action)})`)
  }
  const name = assertSafeName(service, 'service name')
  const command = [
    'if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then',
    `  systemctl ${verb} ${shq(name)} 2>&1 && echo __wsx_ok__`,
    'else',
    `  /etc/init.d/${name} ${verb} 2>&1 && echo __wsx_ok__`,
    'fi',
  ].join('\n')
  const result = await runRemote(target, config, command, { timeoutMs: Math.max(config.timeoutMs, 60_000) })
  const output = (result.stdout || result.stderr || '').trim()
  const ok = /__wsx_ok__/.test(output)
  if (!ok) {
    throw new Error(
      `${target.name}: service ${verb} ${name} failed: ${output || result.error}. ` +
        'Starting and stopping services usually needs root — the SSH user may lack privileges (try a sudo-capable account).',
    )
  }
  return { service: name, action: verb, output }
}

// 目标选择器解析（resolveTargetSelector / requireTargetSelector）已经搬到
// config.js：它跟远程 I/O 无关，而且 manager、工具与命令三条路径必须共用同一份语义。

export { assertSafeName, assertRemotePath, MAX_LOG_LINES, MAX_LIST_ENTRIES }
