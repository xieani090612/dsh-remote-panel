/**
 * dsh-remote-panel —— 展示格式化
 * ============================================================================
 * 纯函数，只负责把结构化数据变成人看的文本。
 * 单独成模块是为了避开循环依赖：命令（给人）和工具（给模型）都要用它，
 * 而它们之间不该互相 import。
 */

/** 人类可读的字节数。 */
export function humanBytes(value) {
  const num = Number(value)
  if (!Number.isFinite(num) || num <= 0) return '—'
  const units = ['B', 'K', 'M', 'G', 'T', 'P']
  let index = 0
  let scaled = num
  while (scaled >= 1024 && index < units.length - 1) {
    scaled /= 1024
    index += 1
  }
  return `${scaled >= 100 || index === 0 ? Math.round(scaled) : scaled.toFixed(1)}${units[index]}`
}

/** 相对时间：面板和命令里都不该出现裸时间戳。 */
export function ago(timestamp) {
  if (!timestamp) return '从未'
  const delta = Date.now() - Number(timestamp)
  if (!Number.isFinite(delta) || delta < 0) return '刚刚'
  const seconds = Math.floor(delta / 1000)
  if (seconds < 60) return `${seconds}s 前`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m 前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h 前`
  return `${Math.floor(hours / 24)}d 前`
}

/**
 * 按**显示宽度**补齐空格。
 * CJK 字符占两格，直接 String.padEnd 会让表格在中文名字那里歪掉。
 */
export function pad(text, width) {
  const str = String(text ?? '')
  let visual = 0
  for (const char of str) {
    visual += /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(char) ? 2 : 1
  }
  return str + ' '.repeat(Math.max(0, width - visual))
}

export const STATUS_GLYPH = { online: '●', offline: '✕', probing: '…', unknown: '?' }

/** 目标的状态符号。 */
export function statusGlyph(status) {
  return STATUS_GLYPH[status] ?? '?'
}
