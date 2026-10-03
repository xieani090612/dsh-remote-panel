/**
 * dsh-remote-panel —— 采集与解析
 * ============================================================================
 * 一次探测 = 一条远程命令（`scripts/probe.sh`）+ 一份分节文本解析。
 *
 * 为什么把整份采集压成**一条**命令：
 *   每条 ssh 调用都要付一次链路往返 + shell 启动成本。要是每个指标一条命令，
 *   一台机器一次探测就是十几条连接，面板会明显变钝，目标机 auth 日志也会爆。
 *   一条命令里用 `sleep 1` 取两次 /proc/stat 采样，正好把 CPU 使用率测准。
 *
 * 解析原则：**任何一节坏掉都不影响其它节**。远程机上的 awk/ps/df 版本千奇百怪，
 * 单节解析失败必须降级成「这一项没有数据」，而不是让整次探测失败。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { flatten, percent, pruneUndefined } from './util.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PROBE_SCRIPT_PATH = path.resolve(HERE, '..', 'scripts', 'probe.sh')

let cachedScript = null

/** 读取采集脚本正文（带缓存）。找不到就抛错 —— 这是打包错误，必须让人看见。 */
export function loadProbeScript() {
  if (cachedScript != null) return cachedScript
  try {
    cachedScript = fs.readFileSync(PROBE_SCRIPT_PATH, 'utf8')
  } catch (error) {
    throw new Error(
      `cannot read the remote probe script at ${PROBE_SCRIPT_PATH}: ${error?.message ?? error}. ` +
        'It ships in scripts/probe.sh — check the package was installed whole.',
    )
  }
  return cachedScript
}

/**
 * 组装要投喂给远程 shell 的完整命令。
 *
 * `TZ=UTC` 是为了让任何涉及时间的远程命令（以及将来可能加的时间戳）不受目标机
 * 本地时区影响；同时把 `LC_ALL=C` 钉死，保证 `df`/`ps` 输出列顺序稳定 ——
 * 否则在某些本地化环境下 `df` 的表头会变、字段位置也会漂。
 */
export function buildProbeCommand() {
  const script = loadProbeScript()
  return [
    'export LC_ALL=C',
    'export TZ=UTC',
    script,
  ].join('\n')
}

/** 分节：`@@@NAME` 开一行，到下一个 `@@@` 或 EOF 为止。 */
function splitSections(text) {
  const sections = {}
  let current = null
  for (const rawLine of String(text ?? '').split(/\r?\n/)) {
    const line = rawLine.replace(/\s+$/, '')
    const marker = /^@@@([A-Z]+)\s*$/.exec(line)
    if (marker) {
      current = marker[1]
      sections[current] = []
      continue
    }
    if (current) sections[current].push(line)
  }
  return sections
}

const num = (value) => {
  if (value === undefined || value === null || value === '') return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

/**
 * 只接受整数值。
 *
 * 为什么单独有这么一个：面板侧的 schema 校验里 `facts.cpuCount` / `facts.uptimeSec`
 * 是**整数**（app/StateValidator.cs 的 `OptNum(..., integer: true)`），一旦发出
 * `2.5` 这种值，校验器会拒收**整份快照**，面板直接空白。所以宁可不发这个字段。
 */
const int = (value) => {
  const parsed = num(value)
  if (parsed === undefined) return undefined
  const rounded = Math.round(parsed)
  return Math.abs(parsed - rounded) < 1e-9 ? rounded : undefined
}

const str = (value) => {
  const text = String(value ?? '').trim()
  return text || undefined
}

/**
 * 由两次 `/proc/stat` 采样算 CPU 使用率。
 *
 * 公式：`busy = Δtotal - Δidle - Δiowait`，也就是「100% - 空闲」，
 * iowait 按空闲算（与 `top` 的 id 列同口径），所以被 IO 打满的机器
 * 不会显示成 CPU 忙。
 *
 * 刻意做成纯函数：旧版把公式放在远程 awk 里，算的是
 * `db=(u2-i2)-(u1-i1)`（user 增量减 idle 增量）——这个差值在真机上几乎总是负数
 * （idle 通常远大于 user），被夹到 0，于是 CPU **永远显示 0%**。
 * 纯函数版本可以用固定样本在单测里钉住这个公式，而 shell 算术不行。
 *
 * @param {{total1?: string, idle1?: string, iowait1?: string, total2?: string, idle2?: string, iowait2?: string}} cpu
 * @returns {number|undefined} 0..100 的百分比（一位小数）；样本不完整时 undefined
 */
export function cpuUsagePercent(cpu) {
  const total1 = num(cpu?.total1)
  const total2 = num(cpu?.total2)
  if (total1 === undefined || total2 === undefined) return undefined
  const dt = total2 - total1
  if (!(dt > 0)) return undefined
  // 计数器是单调递增的；遇到回绕/脏数据时按 0 处理，不要算出负数或 >100。
  const idle = Math.max(0, (num(cpu?.idle2) ?? 0) - (num(cpu?.idle1) ?? 0))
  const iowait = Math.max(0, (num(cpu?.iowait2) ?? 0) - (num(cpu?.iowait1) ?? 0))
  const busy = Math.min(dt, Math.max(0, dt - idle - iowait))
  return Math.round((busy / dt) * 1000) / 10
}

/**
 * 把 `@@@HOST` 里的 `key=value` 行读成对象。
 * 注意：值里可能出现 `=`（例如 os 名字），所以只按**第一个** `=` 切。
 */
function readKeyValues(lines) {
  const out = {}
  for (const line of lines || []) {
    const index = line.indexOf('=')
    if (index <= 0) continue
    out[line.slice(0, index).trim()] = line.slice(index + 1).trim()
  }
  return out
}

/**
 * 解析一次探测输出。
 *
 * @param {string} stdout 远程命令的 stdout
 * @param {string} [stderr] 远程命令的 stderr（用于解释「为什么某节是空的」）
 * @param {{collectDocker?: boolean, collectProcesses?: boolean, collectServices?: boolean, collectGpu?: boolean, services?: string[]}} [options]
 * @returns {{facts: object, metrics: object, warnings: string[], complete: boolean}}
 */
export function parseProbeOutput(stdout, stderr, options = {}) {
  const sections = splitSections(stdout)
  const warnings = []

  // `@@@END` 是**权威**的完成标记：脚本在退出路径上用 trap 保证它一定被打印，
  // 所以「没有 @@@END」就等价于「脚本没跑到底」（被信号打断、超时、或输出被截断）。
  //
  // 早先这里还有个 HOST+MEM 的兜底判断，那是错的：截断恰好发生在 GPU 节之后、
  // 而 HOST/MEM 已经产出时，它会把一份不完整的结果判成 complete —— 正是这个
  // 兜底让「数据缺了一半」看起来一切正常。
  const complete = Boolean(sections.END)

  const host = readKeyValues(sections.HOST)
  const cpuInfoKv = readKeyValues(sections.CPUINFO)
  const cpuCount = int(cpuInfoKv.count)
  const cpuModel = str(cpuInfoKv.model)
  const facts = pruneUndefined({
    hostname: str(host.hostname),
    os: str(host.os),
    kernel: str(host.kernel),
    arch: str(host.arch),
    // cpuModel/cpuCount 以前解析出来又被丢掉，而面板的 CPU 那一行正是
    // 「型号 ×核心数」（app/ViewModels.cs）—— 于是那一行永远是空的。
    cpuModel,
    cpuCount,
    wsl: host.wsl === '1' ? true : host.wsl === '0' ? false : undefined,
    uptimeSec: int(host.uptimeSec),
  })

  // ---- load：/proc/loadavg 是 "0.00 0.01 0.05 1/234 5678" ----
  const loadKv = readKeyValues(sections.LOAD)
  const loadParts = String(loadKv.raw ?? '').trim().split(/\s+/)
  const load1 = num(loadParts[0])
  const load5 = num(loadParts[1])
  const load15 = num(loadParts[2])

  // ---- cpu：百分比由脚本发来的两组原始计数器算出来（见 scripts/probe.sh 的注释） ----
  const cpuKv = readKeyValues(sections.CPU)
  const usagePercent = cpuUsagePercent(cpuKv)

  // ---- memory：脚本直接给字节数 ----
  const memKv = readKeyValues(sections.MEM)
  const memTotal = num(memKv.totalBytes)
  const memAvailable = num(memKv.availableBytes)
  const memUsed = num(memKv.usedBytes)
  const memPct = num(memKv.usagePercent) ?? percent(memUsed, memTotal)

  // ---- disk：`mount|fs|total|used|avail` ----
  const disks = []
  for (const line of sections.DISK || []) {
    const parts = line.split('|')
    if (parts.length < 5) continue
    const total = num(parts[2])
    const used = num(parts[3])
    const avail = num(parts[4])
    if (!total || total <= 0) continue
    disks.push(
      pruneUndefined({
        mount: str(parts[0]),
        fs: str(parts[1]),
        totalBytes: total,
        usedBytes: used,
        availableBytes: avail,
        usagePercent: percent(used, total),
      }),
    )
  }
  // 按占用率倒序：面板最该先看到快满的那个盘。
  disks.sort((a, b) => (b.usagePercent ?? 0) - (a.usagePercent ?? 0))

  // ---- gpu：`index|name|util|memTotal|memUsed|tempC` ----
  const gpus = []
  if (options.collectGpu !== false) {
    for (const line of sections.GPU || []) {
      const parts = line.split('|')
      if (parts.length < 6) continue
      gpus.push(
        pruneUndefined({
          index: num(parts[0]),
          name: str(parts[1]),
          utilizationPercent: num(parts[2]),
          memoryTotalBytes: num(parts[3]),
          memoryUsedBytes: num(parts[4]),
          temperatureC: num(parts[5]),
        }),
      )
    }
  }

  // ---- docker ----
  let docker = null
  if (options.collectDocker !== false) {
    const dockerKv = readKeyValues(sections.DOCKER)
    const available = dockerKv.available === '1'
    const counts = String(dockerKv.counts ?? '').split('|')
    docker = pruneUndefined({
      available,
      version: str(dockerKv.version),
      containers: num(counts[0]),
      running: num(counts[1]),
      paused: num(counts[2]),
      stopped: num(counts[3]),
      images: num(counts[4]),
      // 装了 docker 但 `docker info` 没给出计数：几乎总是 soket 权限问题。
      error: available && !dockerKv.counts ? flatten(stderr || 'docker is installed but `docker info` returned nothing (permission to /var/run/docker.sock?)', 200) : undefined,
    })
  }

  // ---- processes ----
  let processes
  if (options.collectProcesses !== false) {
    const topCpu = []
    const topMem = []
    for (const line of sections.PROC || []) {
      const parts = line.split('|')
      if (parts.length < 6) continue
      const entry = pruneUndefined({
        pid: num(parts[1]),
        user: str(parts[2]),
        cpuPercent: num(parts[3]),
        memPercent: num(parts[4]),
        command: str(parts.slice(5).join('|')),
      })
      if (parts[0] === 'topCpu') topCpu.push(entry)
      else if (parts[0] === 'topMem') topMem.push(entry)
    }
    const procKv = readKeyValues(sections.PROC)
    processes = pruneUndefined({ total: num(procKv.total), topCpu, topMem })
  }

  // ---- services：systemd 正在跑的 unit ----
  let services
  if (options.collectServices !== false) {
    services = []
    for (const line of sections.SVC || []) {
      const parts = line.split('|')
      if (parts.length < 4 || parts[0] !== 'svc') continue
      services.push(pruneUndefined({ name: str(parts[1]), active: str(parts[2]), sub: str(parts[3]) }))
    }
  }

  const metrics = pruneUndefined({
    cpu: pruneUndefined({ usagePercent, load1, load5, load15 }),
    memory: pruneUndefined({
      totalBytes: memTotal,
      usedBytes: memUsed,
      availableBytes: memAvailable,
      swapTotalBytes: num(memKv.swapTotalBytes),
      swapUsedBytes: num(memKv.swapUsedBytes),
      usagePercent: memPct,
    }),
    disks,
    gpus,
    docker,
    processes,
    services,
  })

  // CPU 与内存都拿不到 = 这次采集实质上失败了，可能目标机不是类 Unix 系统。
  if (cpuCount === undefined && cpuModel === undefined && memTotal === undefined) {
    warnings.push('the probe script produced no CPU or memory data — is the target a POSIX host with /proc?')
  }
  if (!complete) {
    warnings.push('the probe output ended before its final marker — the result may be truncated')
  }

  return { facts, metrics, warnings, complete }
}
