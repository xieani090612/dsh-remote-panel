/**
 * dsh-remote-panel —— 共享工具
 * ============================================================================
 * 零依赖的纯函数集合：命令参数构造、超时、输出规范化、数值解析。
 * 刻意不 import 任何 DSH 包 —— 这样这些函数可以在普通 Node 下直接单测。
 */

import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'

// ---------------------------------------------------------------------------
// 零依赖 z-schema 校验器已移除：本插件用普通 JS 对象做配置默认值，
// 避免对 @deepseek-ai/schemastery 的强依赖（它是 DSH 提供的，但保持可选更稳）。
// ---------------------------------------------------------------------------

/**
 * 把任意值压成单行、限长字符串。目标机的错误输出经常是多行堆栈，
 * 而面板和状态文件都只想要一行摘要。
 */
export function flatten(value, max = 300) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`
}

/** 本地路径的 basename，兼容 Windows 与 POSIX 分隔符。 */
export function basename(p) {
  if (!p) return ''
  const parts = String(p).split(/[\\/]/).filter(Boolean)
  return parts.length ? parts[parts.length - 1] : String(p)
}

/**
 * POSIX 单引号转义：`it's` → `'it'\''s'`。
 *
 * 这是本插件注入远程 shell 的唯一入口，所以必须严格：单引号内**除了单引号本身**
 * 没有任何字符有特殊含义，把内层单引号闭合、插一个转义过的单引号、再重新打开即可。
 * 换行、反引号、`$()`、`;`、`|`、`&` 全都被当成字面量。
 */
export function shq(value) {
  return `'${String(value ?? '').replace(/'/g, `'\\''`)}'`
}

/**
 * 运行一个子进程并收集 stdout/stderr，带超时与主动 kill。
 *
 * 关键点：这里用 `spawn` + 手工计时，而不是 `execFile` 的 `timeout` 选项，
 * 因为我们需要在超时后先尝试温和终止、再强杀，并且要把「超时」与「非零退出」
 * 区分开 —— 面板对这两种情况的展示完全不同（超时是链路问题，非零退出往往
 * 只是远程命令自己失败）。
 *
 * @param {string} file 可执行文件
 * @param {string[]} args 参数数组（不经过 shell，避免本地侧二次解析）
 * @param {{timeoutMs?: number, env?: Record<string,string>, input?: string, cwd?: string, maxStdoutBytes?: number}} [options]
 * @returns {Promise<{ok: boolean, code: number|null, signal: string|null, stdout: string, stderr: string, timedOut: boolean, ms: number, error?: string}>}
 */
export function runProcess(file, args, options = {}) {
  const timeoutMs = Math.max(1000, Number(options.timeoutMs) || 20_000)
  // stdout 上限默认 8MB。文件下载那条路会把文件本体放在 stdout 上，
  // 所以它需要一个**显式**的、和文件大小上限匹配的值（见 ops.js）——
  // 否则超限时这里只保留尾部，解码出来的是一个「看起来成功」的损坏文件。
  const maxStdout = Math.max(4096, Number(options.maxStdoutBytes) || 8_000_000)
  return new Promise((resolve) => {
    const startedAt = Date.now()
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false
    let timer = null
    let child = null

    const finish = (extra) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve({
        ok: extra.code === 0 && !timedOut && !extra.error,
        code: extra.code ?? null,
        signal: extra.signal ?? null,
        stdout,
        stderr,
        timedOut,
        ms: Date.now() - startedAt,
        error: extra.error,
      })
    }

    try {
      child = spawn(file, args, {
        env: options.env ? { ...process.env, ...options.env } : process.env,
        cwd: options.cwd,
        windowsHide: true,
        stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      })
    } catch (error) {
      finish({ error: flatten(error?.message || error) })
      return
    }

    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk) => {
      stdout += chunk
      // 上限保护：远程主机若被攻陷或 misconfigured，可能吐出海量输出把 DSH 进程撑爆。
      // 超限时保留**尾部**（离现场最近的那一段最有诊断价值）。
      if (stdout.length > maxStdout) stdout = stdout.slice(-Math.floor(maxStdout / 2))
    })
    child.stderr?.on('data', (chunk) => {
      stderr += chunk
      if (stderr.length > 1_000_000) stderr = stderr.slice(-500_000)
    })

    if (options.input !== undefined && child.stdin) {
      child.stdin.on('error', () => {})
      child.stdin.end(options.input)
    }

    timer = setTimeout(() => {
      timedOut = true
      // 先温和终止；SIGKILL 由下面的兜底负责。
      try {
        child.kill('SIGTERM')
      } catch {
        /* ignore */
      }
      setTimeout(() => {
        try {
          if (!settled) child.kill('SIGKILL')
        } catch {
          /* ignore */
        }
      }, 2000)
    }, timeoutMs)
    if (typeof timer.unref === 'function') timer.unref()

    child.on('error', (error) => finish({ error: flatten(error?.message || error) }))
    child.on('close', (code, signal) => finish({ code, signal }))
  })
}

/**
 * wsl.exe 的输出编码在不同 Windows 版本上不一致：现代版本用 UTF-8，
 * 老版本对部分命令吐 UTF-16LE（每个 ASCII 字符间夹一个 NUL）。
 * 这里做一次嗅探式解码 —— 出现 NUL 就按 UTF-16LE 处理。
 */
export function decodeWslOutput(buffer) {
  if (buffer == null) return ''
  if (typeof buffer === 'string') return stripNuls(buffer)
  const text = Buffer.isBuffer(buffer) ? buffer.toString('utf8') : String(buffer)
  return stripNuls(text)
}

function stripNuls(text) {
  if (!text.includes('\u0000')) return text
  try {
    return Buffer.from(text, 'utf8').toString('utf16le')
  } catch {
    return text.replace(/\u0000/g, '')
  }
}

/** 把 `1.5G` / `2048` / `512M` 这类人类可读容量解析成字节数。 */
export function parseHumanBytes(value) {
  const text = String(value ?? '').trim()
  const match = /^([0-9]*\.?[0-9]+)\s*([kKmMgGtTpP]?)(?:i?[bB])?$/.exec(text)
  if (!match) return undefined
  const num = Number(match[1])
  if (!Number.isFinite(num)) return undefined
  const unit = match[2].toUpperCase()
  const scale = { '': 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4, P: 1024 ** 5 }[unit]
  return scale ? Math.round(num * scale) : undefined
}

/** 保留一位小数的百分比，避免状态文件里出现 33.33333333333333。 */
export function percent(used, total) {
  const u = Number(used)
  const t = Number(total)
  if (!Number.isFinite(u) || !Number.isFinite(t) || t <= 0) return undefined
  return Math.round((u / t) * 1000) / 10
}

/**
 * 原子写文件：同目录临时文件 + rename，读者永远看不到半截内容。
 *
 * 只有同步版：两个调用方（心跳 tick 与 dispose 收尾）都在同步上下文里，
 * 异步版没有任何调用点，留着只是多一份要维护的路径。
 */
export function writeFileAtomicSync(target, contents) {
  const dir = path.dirname(target)
  fs.mkdirSync(dir, { recursive: true })
  const tmp = tempPathFor(target)
  try {
    fs.writeFileSync(tmp, contents, 'utf8')
    fs.renameSync(tmp, target)
  } catch (error) {
    // 失败时清掉临时文件：写盘是心跳级频率，一个持续失败的写入
    // （磁盘满、目标被占用）会在数据目录里堆出一串 *.tmp。
    try {
      fs.rmSync(tmp, { force: true })
    } catch {
      /* ignore */
    }
    throw error
  }
}

/**
 * 临时文件名 = 目标 + pid + 时间戳 + 自增序号。
 * 序号不是装饰：心跳与「探测完成」可能落在同一毫秒里，两次写撞同一个临时文件
 * 会互相截断，rename 之后就可能把一个半截文件当成快照发布出去。
 */
let tempSeq = 0
function tempPathFor(target) {
  tempSeq = (tempSeq + 1) % 1_000_000
  return `${target}.${process.pid}.${Date.now()}.${tempSeq}.tmp`
}

/** 把数值夹到 [min, max]；非数值回落到 min。 */
export function clamp(value, min, max) {
  const num = Number(value)
  if (!Number.isFinite(num)) return min
  return Math.min(max, Math.max(min, num))
}

/** 一个永不抛异常的取值器，用于「观察失败也绝不能连累 DSH」的场景。 */
export function safe(fn, fallback) {
  try {
    return fn()
  } catch {
    return fallback
  }
}

/**
 * 去掉 undefined 的键，让状态文件更干净。
 *
 * 只递归**普通对象**与数组：Date / Buffer / Map / 类实例不是 JSON 对象，
 * 按 key 展开会变成 `{}` —— 那是**静默丢数据**，比留下一个 undefined 更糟。
 */
export function pruneUndefined(object) {
  if (!object || typeof object !== 'object') return object
  if (Array.isArray(object)) return object.map(pruneUndefined)
  const proto = Object.getPrototypeOf(object)
  if (proto !== Object.prototype && proto !== null) return object
  const out = {}
  for (const [key, value] of Object.entries(object)) {
    if (value === undefined) continue
    out[key] = pruneUndefined(value)
  }
  return out
}
