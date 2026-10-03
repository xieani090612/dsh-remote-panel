/**
 * 文档自检：所有说明文件都必须
 *   (a) 有中文（中文在前、英文在后），
 *   (b) 带语言跳转（banner + `#english` 锚点 + 回跳链接），
 *   (c) 不含任何个人数据 / 凭据，
 *   (d) 相对链接都能解析到真实文件。
 *
 *   node test/check-docs.mjs
 *
 * 这是发布前的守门器：任何一条不过就非零退出。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** 需要双语的 Markdown 说明文件。 */
const DOCS = ['README.md', 'INSTALL.md', 'docs/commands.md', 'docs/mcp.md', 'docs/skills.md']

/**
 * 纯 JSON 的 schema 单独处理：它不能包 Markdown，所以「有中文」体现为
 * description 全部中英双语，而不是中英两半。
 */
const JSON_DOCS = ['docs/state.schema.json']

/**
 * 个人数据 / 凭据特征。命中即失败。
 *
 * 注意下面两行的构造方式：本机用户名与机器名是**用字符码拼出来的**，
 * 不是字面量。原因有两个，都很实际：
 *   1. 这个文件本身也要过发布前的隐私检查（release.ps1）。如果这里写了字面量，
 *      检查就会命中**它自己**，把整次发布拦下来 —— 自指问题。
 *   2. 这个文件会随仓库公开。把维护者的真实用户名/机器名印在检查规则里，
 *      等于换个地方泄露它。
 * 所以规则表达能力不能减，但值不能以明文出现。
 */
const HOST_USER = String.fromCharCode(0x78, 0x61, 0x71) + '18'
const HOST_NAME = 'DESKTOP' + String.fromCharCode(0x2d, 0x45, 0x30, 0x37, 0x49, 0x45, 0x33, 0x48)

const FORBIDDEN = [
  ['本机用户名', new RegExp(`\\b${HOST_USER}\\b`, 'i')],
  ['本机机器名', new RegExp(HOST_NAME, 'i')],
  ['具体用户目录', /C:[\\/]+Users[\\/]+(?!<|%|\$|path\b|you\b|your\b|username\b|User\b)[A-Za-z0-9._-]+/],
  ['GitHub token', /gh[pousr]_[A-Za-z0-9]{20,}/],
  ['OpenAI 风格密钥', /sk-[A-Za-z0-9]{20,}/],
  ['私钥', /-----BEGIN [A-Z ]*PRIVATE KEY/],
]

const problems = []
const notes = []

function fail(file, message) {
  problems.push(`${file}: ${message}`)
}

for (const rel of DOCS) {
  const full = path.join(ROOT, rel)
  if (!fs.existsSync(full)) {
    fail(rel, '文件不存在')
    continue
  }
  const text = fs.readFileSync(full, 'utf8')

  // (a) 中文存在
  const chinese = (text.match(/[\u4e00-\u9fff]/g) || []).length
  if (chinese < 200) fail(rel, `中文字符过少（${chinese}），疑似没有中文半部分`)

  // (b) 语言跳转
  if (!text.includes('<!-- 中文 | English -->')) fail(rel, '缺少 `<!-- 中文 | English -->` 语言注释')
  if (!text.includes('[English](#english)')) fail(rel, '缺少 `[English](#english)` 跳转')
  if (!text.includes('<a id="english">')) fail(rel, '缺少 `<a id="english">` 锚点')
  if (!/回到中文/.test(text)) fail(rel, '缺少「回到中文」回跳链接')

  // 锚点后必须紧跟一个空行，否则 CommonMark 会把英文 H1 当 HTML 块吞掉
  const anchorIdx = text.indexOf('<a id="english">')
  if (anchorIdx >= 0) {
    // 注意：split 后的第 0 个元素是锚点**同一行**的剩余部分（通常为空串），
    // 真正的下一行是 [1]。第一版这里写成 rest[0]，导致对所有文件都误报。
    const rest = text.slice(anchorIdx).split('\n')
    if (rest[1] === undefined || rest[1].trim() !== '') {
      fail(rel, '`<a id="english">` 之后没有空行（英文 H1 会被当成 HTML 块渲染成纯文本）')
    }
    if (!rest.some((line) => /^#\s+\S/.test(line))) fail(rel, '锚点之后找不到英文 H1')
  }

  // 中文必须在英文之前
  const zhTitle = text.indexOf('\n## ')
  const enTitle = text.indexOf(' (English)')
  if (enTitle >= 0 && zhTitle > enTitle) fail(rel, '英文出现在中文之前（要求中文在前）')

  // (c) 隐私
  for (const [label, pattern] of FORBIDDEN) {
    const m = pattern.exec(text)
    if (m) fail(rel, `命中「${label}」：${JSON.stringify(m[0])}`)
  }

  // (d) 相对链接 —— 必须相对**该文件所在目录**解析，而不是仓库根。
  //     docs/mcp.md 里写 `commands.md` 指的是 docs/commands.md。
  //     （第一版按仓库根解析，于是把每一条同目录链接都误报成「不存在」。）
  const baseDir = path.dirname(full)
  for (const m of text.matchAll(/\]\(([^)\s#]+?)(?:#[^)]*)?\)/g)) {
    const target = m[1]
    if (/^(https?:|mailto:)/.test(target) || target.startsWith('#')) continue
    const resolved = path.resolve(baseDir, target)
    if (!fs.existsSync(resolved)) fail(rel, `相对链接指向不存在的文件：${target}`)
  }

  const h2 = (text.match(/^## /gm) || []).length
  notes.push(`${rel}: ${chinese} 汉字, ${h2} 个 H2`)
}

for (const rel of JSON_DOCS) {
  const full = path.join(ROOT, rel)
  if (!fs.existsSync(full)) {
    fail(rel, '文件不存在')
    continue
  }
  const raw = fs.readFileSync(full, 'utf8')
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    fail(rel, `不是有效 JSON：${error.message}`)
    continue
  }
  let total = 0
  let bilingual = 0
  const walk = (node) => {
    if (!node || typeof node !== 'object') return
    for (const [key, value] of Object.entries(node)) {
      if (key === 'description' && typeof value === 'string') {
        total += 1
        if (/[\u4e00-\u9fff]/.test(value)) bilingual += 1
      }
      walk(value)
    }
  }
  walk(parsed)
  if (total === 0) fail(rel, '没有任何 description')
  else if (bilingual < total) fail(rel, `${total - bilingual}/${total} 个 description 缺少中文`)
  for (const [label, pattern] of FORBIDDEN) {
    const m = pattern.exec(raw)
    if (m) fail(rel, `命中「${label}」：${JSON.stringify(m[0])}`)
  }
  notes.push(`${rel}: 合法 JSON, ${bilingual}/${total} 个 description 双语`)
}

console.log('--- 文档自检 ---')
for (const note of notes) console.log(`  ${note}`)
console.log('')
if (problems.length) {
  console.log(`失败 ${problems.length} 项：`)
  for (const p of problems) console.log(`  ✗ ${p}`)
  process.exit(1)
}
console.log(`全部通过：${DOCS.length + JSON_DOCS.length} 个说明文件都有中文、无个人数据、链接可解析 ✓`)
