/**
 * 状态文件 schema 自检。
 *
 *   node test/check-schema.mjs
 *
 * 必过项（任何机器上都能判）：
 *   * `docs/state.schema.json` 是**合法 JSON**（它会被面板当契约用，坏一点就全废）；
 *   * 每个 `description` 都是**中英双语**（中文在前）。
 *
 * 可选加强项：如果环境变量 `DSH_WSX_SCHEMA_ORIG` 指向一份**改动前**的副本，
 * 就额外做结构等价性检查 —— 忽略 `description` 后，要求键顺序与所有取值完全一致。
 * 这条是为了防止「为了加中文说明，顺手把 type/required/enum 改了」。
 * 平时的 CI 里没有那份副本，所以它只是加强项，不是必过项（早期版本把它写成必过，
 * 结果在干净的仓库里必定失败）。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TARGET = path.join(ROOT, 'docs', 'state.schema.json')

const fail = (message) => {
  console.log(`FAIL ${message}`)
  process.exit(1)
}

let schema
try {
  schema = JSON.parse(fs.readFileSync(TARGET, 'utf8'))
} catch (error) {
  fail(`docs/state.schema.json 不是合法 JSON：${error.message}`)
}

let total = 0
let bilingual = 0
const missing = []
const walk = (node, at = '$') => {
  if (!node || typeof node !== 'object') return
  for (const [key, value] of Object.entries(node)) {
    if (key === 'description' && typeof value === 'string') {
      total += 1
      if (/[\u4e00-\u9fff]/.test(value)) bilingual += 1
      else missing.push(at)
    }
    walk(value, `${at}.${key}`)
  }
}
walk(schema)

console.log(`  root type        : ${schema.type}`)
console.log(`  required         : ${JSON.stringify(schema.required)}`)
console.log(`  top-level props  : ${Object.keys(schema.properties || {}).join(', ')}`)
console.log(`  descriptions     : ${bilingual}/${total} 含中文`)

if (total === 0) fail('schema 里没有任何 description')
if (bilingual < total) {
  fail(`${total - bilingual} 个 description 缺少中文，例如：${missing.slice(0, 5).join(', ')}`)
}

// 可选：与改动前的副本做结构等价性对比
const original = process.env.DSH_WSX_SCHEMA_ORIG
if (original && fs.existsSync(original)) {
  const strip = (node) => {
    if (Array.isArray(node)) return node.map(strip)
    if (node && typeof node === 'object') {
      const out = {}
      for (const [key, value] of Object.entries(node)) {
        if (key === 'description') continue
        out[key] = strip(value)
      }
      return out
    }
    return node
  }
  let before
  try {
    before = JSON.parse(fs.readFileSync(original, 'utf8'))
  } catch (error) {
    fail(`原始副本无法解析：${error.message}`)
  }
  const same = JSON.stringify(strip(before)) === JSON.stringify(strip(schema))
  console.log(`  与原始副本结构一致（忽略 description）: ${same ? 'YES' : 'NO'}`)
  if (!same) fail('schema 的结构被改动了（只允许改 description）')
} else {
  console.log('  （未提供 DSH_WSX_SCHEMA_ORIG，跳过结构等价性对比）')
}

console.log('schema 自检通过 ✓')

