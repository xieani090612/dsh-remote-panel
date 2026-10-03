/**
 * 一次跑完所有离线测试。
 *
 *   node test/run-all.mjs [wsl-distro]
 *
 * 需要 WSL 的用例（smoke / mcp）在拿不到发行版时会**跳过而不是失败** ——
 * 这样在没有 WSL 的机器上也能跑回归。
 */

import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const distro = process.argv[2] || 'Ubuntu-24.04'

/** 这些用例不碰网络、不碰 WSL，任何机器上都应该通过。 */
const OFFLINE = [
  ['unit', 'unit.test.mjs'],
  ['client-contract', 'client.test.mjs'],
  ['lossless-json', 'lossless.test.mjs'],
  // 文档自检：所有说明文件必须都有中文、无个人数据、链接可解析。
  // 放在这里是为了当发布闸门 —— 改文档时忘了同步中英文，或者不小心把
  // 本机用户名/家目录路径写进文档，都会在跑测试时立刻暴露。
  ['docs', 'check-docs.mjs'],
  // 状态文件 schema 必须仍是合法 JSON，且结构没被改动（只允许改 description）。
  ['schema', 'check-schema.mjs'],
]

/** 这些需要能连上本机 WSL；连不上就跳过。 */
const NEEDS_WSL = [
  ['smoke', 'smoke.test.mjs'],
  ['mcp', 'mcp.test.mjs'],
]

function run(script, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(HERE, script), ...args], {
      stdio: 'inherit',
      env: { ...process.env, WSL_UTF8: '1' },
    })
    child.on('exit', (code) => resolve(code ?? 1))
    child.on('error', () => resolve(1))
  })
}

const results = []
for (const [label, script] of OFFLINE) {
  console.log(`\n===== ${label} (${script}) =====`)
  results.push([label, await run(script, [])])
}

for (const [label, script] of NEEDS_WSL) {
  console.log(`\n===== ${label} (${script}) =====`)
  const code = await run(script, [distro])
  results.push([label, code])
  if (code !== 0) console.log(`  (${label} 需要本机有可用的 WSL 发行版 ${distro}；失败时会记在下面)`)
}

console.log('\n===== summary =====')
let failed = 0
for (const [label, code] of results) {
  console.log(`${code === 0 ? 'PASS' : 'FAIL'}  ${label}`)
  if (code !== 0) failed += 1
}
console.log(`\n${results.length - failed}/${results.length} suites passed`)
process.exit(failed ? 1 : 0)
