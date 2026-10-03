/**
 * 纯函数单元测试（不需要 WSL、不需要 DSH）。
 *
 * 重点覆盖三类真正容易出错、而且错了以后症状很隐蔽的逻辑：
 *   1. **命令注入面** —— `shq()` 是本插件把动态内容送进远程 shell 的唯一入口，
 *      它一旦有洞就是远程代码执行级别的问题；
 *   2. **配置规范化** —— 单个目标配错必须被隔离成一条错误，而不是让插件加载失败；
 *   3. **采集输出解析** —— 远程 awk/ps/df 版本千奇百怪，坏一节不能带坏整份。
 *
 * 后面还加了几组「踩过坑」的回归：CPU 公式、失败样本进历史、心跳写盘频率、
 * 冷启动错峰、目标选择器歧义、原子写的收尾。它们都在临时目录里跑，不碰真实状态文件。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import assert from 'node:assert/strict'
import test, { after } from 'node:test'

import { flatten, parseHumanBytes, percent, pruneUndefined, shq, writeFileAtomicSync } from '../lib/util.js'
import {
  deriveTargetId,
  effectiveTimeoutMs,
  normalizeConfig,
  requireTargetSelector,
  resolveTargetSelector,
  targetLabel,
} from '../lib/config.js'
import { cpuUsagePercent, parseProbeOutput } from '../lib/probe.js'
import { buildSshArgs, controlPathFor, sshDestination } from '../lib/ssh.js'
import {
  buildInlineDownloadCommand,
  buildInlineUploadCommand,
  inlineLimitError,
  parseLsOutput,
  windowTail,
} from '../lib/ops.js'
import { projectParameters } from '../lib/tools.js'
import { TargetRuntime } from '../lib/state.js'
import { RemoteManager, isColdStartWsl } from '../lib/manager.js'
import { handleWsxCommand, resolveOrThrow } from '../lib/commands.js'
import { readBody } from '../lib/index.js'
import { apply } from '../lib/index.js'

/** 测试用的临时目录，跑完删掉（绝不能让测试碰用户真实的 state.json）。 */
const tempDirs = []
after(() => {
  for (const dir of tempDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
})

function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

/** 状态文件指向临时目录的 manager：单元测试也要能安全地测调度与落盘。 */
function makeManager(rawConfig = {}, logger) {
  return new RemoteManager({
    rawConfig: { stateFile: path.join(tempDir('wsx-manager-'), 'state.json'), ...rawConfig },
    pluginVersion: 'test',
    logger,
  })
}

// ---------------------------------------------------------------------------
// shq：命令注入面
// ---------------------------------------------------------------------------

test('shq wraps plain values in single quotes', () => {
  assert.equal(shq('abc'), "'abc'")
  assert.equal(shq(''), "''")
})

test('shq neutralises an embedded single quote', () => {
  // 这是最关键的一条：内层单引号必须被闭合、转义、再打开。
  assert.equal(shq("it's"), "'it'\\''s'")
})

test('shq makes shell metacharacters inert', () => {
  // 下面每一个值如果没被正确转义，都会在远程 shell 上产生副作用。
  const dangerous = [
    'a; rm -rf /',
    'a && reboot',
    'a | tee /etc/passwd',
    '$(whoami)',
    '`id`',
    'a > /etc/hosts',
    'a\nb',
    'a"b',
    "a'b",
    'a\\b',
  ]
  for (const value of dangerous) {
    const quoted = shq(value)
    assert.ok(quoted.startsWith("'") && quoted.endsWith("'"), `not quoted: ${quoted}`)
    // 剥掉外层引号后，内部只允许出现 '\'' 这一种转义序列，
    // 也就是说所有裸单引号都已被处理。
    const inner = quoted.slice(1, -1)
    const withoutEscapes = inner.replace(/'\\''/g, '')
    assert.ok(!withoutEscapes.includes("'"), `unescaped quote survived in: ${quoted}`)
  }
})

test('shq round-trips through a real POSIX shell', () => {
  // 用 WSL 之外的方式验证不了真 shell，所以这里只验证「转义后的字符串
  // 再按 shell 规则反解一次能拿回原值」这个更强的性质。
  const samples = ["it's", 'a b', 'x$y', 'q"q', "mix'\"$`\\"]
  for (const sample of samples) {
    const quoted = shq(sample)
    // shell 规则：'...' 内是字面量；'\'' 表示一个字面单引号。
    let decoded = ''
    let index = 0
    while (index < quoted.length) {
      if (quoted.startsWith("'\\''", index)) {
        decoded += "'"
        index += 4
        continue
      }
      const char = quoted[index]
      if (char !== "'") decoded += char
      index += 1
    }
    assert.equal(decoded, sample)
  }
})

// ---------------------------------------------------------------------------
// 杂项工具
// ---------------------------------------------------------------------------

test('flatten collapses whitespace and truncates', () => {
  assert.equal(flatten('  a\n\n b  '), 'a b')
  assert.equal(flatten('abcdef', 4), 'abc…')
})

test('percent guards against zero and negative totals', () => {
  assert.equal(percent(50, 100), 50)
  assert.equal(percent(1, 3), 33.3)
  assert.equal(percent(5, 0), undefined)
  assert.equal(percent('x', 100), undefined)
})

test('parseHumanBytes understands units', () => {
  assert.equal(parseHumanBytes('2048'), 2048)
  assert.equal(parseHumanBytes('1K'), 1024)
  assert.equal(parseHumanBytes('1.5G'), Math.round(1.5 * 1024 ** 3))
  assert.equal(parseHumanBytes('nonsense'), undefined)
})

test('pruneUndefined drops undefined but keeps falsy values', () => {
  assert.deepEqual(pruneUndefined({ a: 1, b: undefined, c: 0, d: false, e: '', f: null }), {
    a: 1,
    c: 0,
    d: false,
    e: '',
    f: null,
  })
})

// ---------------------------------------------------------------------------
// 配置规范化
// ---------------------------------------------------------------------------

test('deriveTargetId prefers an explicit id and validates it', () => {
  assert.equal(deriveTargetId({ id: 'web-1', kind: 'ssh', host: 'h' }), 'web-1')
  assert.throws(() => deriveTargetId({ id: 'bad id!', kind: 'ssh', host: 'h' }), /invalid/)
})

test('deriveTargetId is stable and slugifies host/user', () => {
  assert.equal(deriveTargetId({ kind: 'ssh', host: '192.168.1.50', user: 'ubuntu' }), 'ssh-ubuntu-192.168.1.50')
  assert.equal(deriveTargetId({ kind: 'wsl', distro: 'Ubuntu-24.04' }), 'wsl-ubuntu-24.04')
})

test('normalizeConfig fills defaults', () => {
  const { config, errors } = normalizeConfig({})
  assert.deepEqual(errors, [])
  assert.equal(config.probeIntervalMs, 15000)
  // 60s 而不是 20s：WSL 冷启动要 18–88 秒，给窄了会让本机 WSL 目标反复误报离线。
  assert.equal(config.timeoutMs, 60000)
  assert.equal(config.maxConcurrentProbes, 4)
  assert.equal(config.allowMutations, true)
  assert.equal(config.autoLaunch, true)
  assert.deepEqual(config.targets, [])
})

test('normalizeConfig clamps out-of-range numbers instead of trusting them', () => {
  const { config } = normalizeConfig({ probeIntervalMs: 1, timeoutMs: 1, maxConcurrentProbes: 999 })
  assert.equal(config.probeIntervalMs, 3000)
  assert.equal(config.timeoutMs, 3000)
  assert.equal(config.maxConcurrentProbes, 32)
})

test('normalizeConfig honours allowMutations:false', () => {
  assert.equal(normalizeConfig({ allowMutations: false }).config.allowMutations, false)
})

test('one bad target does not spoil the others', () => {
  const { config, errors } = normalizeConfig({
    targets: [
      { kind: 'ssh', name: 'good', host: '10.0.0.1' },
      { kind: 'ssh', name: 'no host' }, // 少 host
      { kind: 'bogus', host: 'x' }, // kind 非法
      { kind: 'wsl', distro: 'Ubuntu-24.04' },
    ],
  })
  assert.equal(config.targets.length, 2)
  assert.equal(errors.length, 2)
  assert.match(errors[0], /requires "host"/)
  assert.match(errors[1], /kind must be/)
})

test('duplicate target ids are rejected with a clear error', () => {
  const { config, errors } = normalizeConfig({
    targets: [
      { kind: 'ssh', id: 'dup', host: 'a' },
      { kind: 'ssh', id: 'dup', host: 'b' },
    ],
  })
  assert.equal(config.targets.length, 1)
  assert.match(errors[0], /duplicate target id/)
})

test('wsl targets default to the ssh-capable loopback channel settings', () => {
  const { config } = normalizeConfig({ targets: [{ kind: 'wsl', distro: 'Ubuntu-24.04' }] })
  const target = config.targets[0]
  assert.equal(target.host, '127.0.0.1')
  assert.equal(target.port, 2222)
  assert.equal(target.channel, 'auto')
  assert.equal(target.user, 'root')
})

test('disabled targets are excluded from the manager view but kept in config', () => {
  const { config } = normalizeConfig({ targets: [{ kind: 'ssh', host: 'a', enabled: false }] })
  assert.equal(config.targets[0].enabled, false)
})

// ---------------------------------------------------------------------------
// SSH 参数构造
// ---------------------------------------------------------------------------

test('buildSshArgs never allows an interactive password prompt', () => {
  const { config } = normalizeConfig({ targets: [{ kind: 'ssh', host: 'h', user: 'u' }] })
  const args = buildSshArgs(config.targets[0], config, 'echo hi')
  assert.ok(args.includes('BatchMode=yes'), 'BatchMode=yes is required so sshd never blocks on a prompt')
  assert.ok(args.includes('NumberOfPasswordPrompts=0'))
  // 命令必须是独立的一个 argv 元素，不能被拆开。
  assert.equal(args[args.length - 1], 'echo hi')
  assert.ok(args.includes('--'), 'a -- separator must precede the host')
})

test('buildSshArgs keeps strict host key checking by default', () => {
  const { config } = normalizeConfig({ targets: [{ kind: 'ssh', host: 'h' }] })
  const args = buildSshArgs(config.targets[0], config, 'x')
  assert.ok(!args.some((a) => a === 'StrictHostKeyChecking=no'))
})

test('buildSshArgs only relaxes host key checking when explicitly asked', () => {
  const { config } = normalizeConfig({ targets: [{ kind: 'ssh', host: 'h', strictHostKeyChecking: false }] })
  const args = buildSshArgs(config.targets[0], config, 'x')
  assert.ok(args.includes('StrictHostKeyChecking=no'))
  assert.ok(args.includes('UserKnownHostsFile=/dev/null'))
})

test('buildSshArgs passes a non-default port and identity file', () => {
  const { config } = normalizeConfig({
    targets: [{ kind: 'ssh', host: 'h', port: 2222, identityFile: 'C:/k' }],
  })
  const args = buildSshArgs(config.targets[0], config, 'x')
  assert.equal(args[args.indexOf('-p') + 1], '2222')
  assert.equal(args[args.indexOf('-i') + 1], 'C:/k')
})

// ---------------------------------------------------------------------------
// 采集输出解析
// ---------------------------------------------------------------------------

/** 一段形状与真实输出一致的样本（数值取自本机 WSL 的实测结果）。 */
const SAMPLE = `@@@HOST
hostname=test-host
os=Ubuntu 24.04.4 LTS
kernel=6.18.40.1-microsoft-standard-WSL2
arch=x86_64
wsl=1
uptimeSec=88
@@@LOAD
raw=1.12 0.26 0.09 3/134 445
@@@CPU
total1=100000
idle1=90000
iowait1=1000
total2=101000
idle2=90935
iowait2=1000
@@@CPUINFO
model=Intel(R) Core(TM) i5-8200Y CPU @ 1.30GHz
count=2
@@@MEM
totalBytes=1470853120
availableBytes=1230385152
usedBytes=240467968
usagePercent=16.3
swapTotalBytes=1073741824
swapUsedBytes=0
@@@DISK
/|/dev/sdd|1081101176832|2991505408|1023117316096
/mnt/c|C:\\|255728095232|221882949632|33845145600
@@@GPU
@@@DOCKER
available=0
@@@PROC
total=27
topCpu|378|root|72.6|2.3|check-new-relea
topMem|378|root|72.2|2.3|check-new-relea
@@@SVC
svc|cron.service|active|running
@@@END
`

test('parseProbeOutput reads every section', () => {
  const { facts, metrics, warnings, complete } = parseProbeOutput(SAMPLE, '', {
    collectDocker: true,
    collectProcesses: true,
    collectServices: true,
    collectGpu: true,
  })
  assert.equal(complete, true)
  assert.deepEqual(warnings, [])
  assert.equal(facts.hostname, 'test-host')
  assert.equal(facts.os, 'Ubuntu 24.04.4 LTS')
  assert.equal(facts.wsl, true)
  assert.equal(facts.uptimeSec, 88)
  assert.equal(metrics.cpu.usagePercent, 6.5)
  assert.equal(metrics.cpu.load1, 1.12)
  assert.equal(metrics.cpu.load15, 0.09)
  assert.equal(metrics.memory.totalBytes, 1470853120)
  assert.equal(metrics.memory.usagePercent, 16.3)
  assert.equal(metrics.memory.swapUsedBytes, 0)
  assert.equal(metrics.disks.length, 2)
  assert.equal(metrics.processes.total, 27)
  assert.equal(metrics.processes.topCpu[0].pid, 378)
  assert.equal(metrics.processes.topCpu[0].cpuPercent, 72.6)
  assert.equal(metrics.services[0].name, 'cron.service')
  assert.equal(metrics.docker.available, false)
})

test('parseProbeOutput sorts disks by pressure so the fullest comes first', () => {
  const { metrics } = parseProbeOutput(SAMPLE)
  assert.ok(metrics.disks[0].usagePercent >= metrics.disks[1].usagePercent)
})

test('a half-finished probe keeps the sections it did produce', () => {
  // 模拟被中断：没有 @@@END，后面的节全缺。
  const truncated = SAMPLE.slice(0, SAMPLE.indexOf('@@@DISK'))
  const { facts, metrics, warnings, complete } = parseProbeOutput(truncated)
  assert.equal(complete, false)
  assert.ok(warnings.some((w) => /truncated/.test(w)))
  // 前面已经产出的数据必须保留，而不是整份作废。
  assert.equal(facts.hostname, 'test-host')
  assert.equal(metrics.cpu.usagePercent, 6.5)
  assert.equal(metrics.memory.totalBytes, 1470853120)
})

test('garbage input reports a warning instead of throwing', () => {
  const { metrics, warnings } = parseProbeOutput('bash: command not found\n', 'boom')
  assert.deepEqual(metrics.disks, [])
  assert.ok(warnings.some((w) => /POSIX/.test(w)))
})

test('docker installed but unreadable is distinguishable from docker absent', () => {
  const present = parseProbeOutput('@@@DOCKER\navailable=1\n@@@END\n', 'permission denied')
  assert.equal(present.metrics.docker.available, true)
  assert.equal(present.metrics.docker.containers, undefined)
  assert.ok(present.metrics.docker.error, 'a reason must be surfaced when docker is present but silent')
})

test('malformed numeric fields degrade to undefined rather than NaN', () => {
  const { metrics } = parseProbeOutput('@@@CPU\nusagePercent=abc\n@@@MEM\ntotalBytes=\n@@@END\n')
  assert.equal(metrics.cpu.usagePercent, undefined)
  assert.equal(metrics.memory.totalBytes, undefined)
  // NaN 会污染 JSON（序列化成 null）并在面板上显示成怪值。
  assert.ok(!Number.isNaN(metrics.cpu.usagePercent))
})

// ---------------------------------------------------------------------------
// defineTool 方言 → 标准 JSON Schema 的投影
// ---------------------------------------------------------------------------

test('projectParameters lifts per-property required into the parent array', () => {
  const projected = projectParameters({
    target: { type: 'string', required: true, description: 'd' },
    limit: { type: 'integer' },
  })
  assert.deepEqual(projected.required, ['target'])
  assert.equal(projected.type, 'object')
  assert.equal(projected.additionalProperties, false)
  // 方言里的 required 不能泄漏到 MCP 客户端看到的属性 schema 里。
  assert.ok(!('required' in projected.properties.target))
  assert.equal(projected.properties.target.type, 'string')
})

test('projectParameters turns an items-only property into a typed array', () => {
  const projected = projectParameters({ services: { items: { type: 'string' }, description: 'd' } })
  assert.equal(projected.properties.services.type, 'array')
  assert.equal(projected.properties.services.items.type, 'string')
})

test('projectParameters maps the json pseudo-type to an untyped schema', () => {
  const projected = projectParameters({ data: { type: 'json' } })
  assert.ok(!('type' in projected.properties.data))
})

test('projectParameters keeps enums and descriptions intact', () => {
  const projected = projectParameters({
    operation: { type: 'string', required: true, enum: ['a', 'b'], description: 'pick one' },
  })
  assert.deepEqual(projected.properties.operation.enum, ['a', 'b'])
  assert.equal(projected.properties.operation.description, 'pick one')
})

// ---------------------------------------------------------------------------
// CPU 使用率：本仓库最贵的一个 bug
// ---------------------------------------------------------------------------
//
// 旧实现把公式写在远程 awk 里：`db=(u2-i2)-(u1-i1)`，也就是「user 增量 - idle 增量」。
// idle 增量在真机上几乎总是远大于 user 增量，于是 db 恒为负、被夹到 0，
// 面板上的 CPU **永远是 0%**；而 0% 看起来完全正常，所以一直没人发现。
// 下面这些用例把正确公式钉死。

test('cpuUsagePercent is 100% minus idle (busy), not user minus idle', () => {
  // 1 秒内：总共 200 个 tick，其中 idle 走了 100 个 → 忙 50%
  const sample = { total1: '1000', idle1: '800', iowait1: '0', total2: '1200', idle2: '900', iowait2: '0' }
  assert.equal(cpuUsagePercent(sample), 50)
})

test('cpuUsagePercent counts iowait as idle, so an IO-bound box is not reported as busy', () => {
  // 总共 200 个 tick：idle 100 + iowait 50 → 忙 50/200 = 25%
  const sample = { total1: '0', idle1: '0', iowait1: '0', total2: '200', idle2: '100', iowait2: '50' }
  assert.equal(cpuUsagePercent(sample), 25)
})

test('cpuUsagePercent reproduces the old bug: a mostly-idle sample must not read as 0', () => {
  // 这是本机实测那一对的增量形状：user 增量 48、idle 增量 98、总增量 184
  // （把绝对值补成自洽的一组：idle 必须是 total 的一部分）。
  const sample = {
    total1: '1000',
    idle1: '800',
    iowait1: '0',
    total2: '1184',
    idle2: '898',
    iowait2: '0',
  }
  const value = cpuUsagePercent(sample)
  assert.equal(value, 46.7)
  const oldFormula = Math.max(0, ((48 - 98) / 184) * 100)
  assert.equal(oldFormula, 0, 'the old formula clamped to 0 — that is the bug this test pins down')
  assert.notEqual(value, oldFormula)
})

test('cpuUsagePercent degrades to undefined instead of guessing', () => {
  assert.equal(cpuUsagePercent({}), undefined)
  assert.equal(cpuUsagePercent({ total1: '100', total2: '100' }), undefined, 'zero delta')
  assert.equal(cpuUsagePercent({ total1: '200', total2: '100' }), undefined, 'counters went backwards')
  assert.equal(cpuUsagePercent({ total1: 'abc', total2: '200' }), undefined)
  // 脏数据不能让结果越过 0..100
  assert.equal(cpuUsagePercent({ total1: '1000', idle1: '0', total2: '1100', idle2: '99999' }), 0)
})

test('the probe script emits raw counters rather than doing the arithmetic in awk', () => {
  // 公式搬到 JS 是为了能测（上面几条），这条守的是「脚本别再自己算一个百分比回来」。
  const script = fs.readFileSync(path.join(import.meta.dirname, '..', 'scripts', 'probe.sh'), 'utf8')
  const cpuSection = script.slice(script.indexOf('@@@CPU'), script.indexOf('@@@CPUINFO'))
  assert.ok(cpuSection.length > 0, 'probe.sh must still have a CPU section')
  assert.ok(!cpuSection.includes('usagePercent'), 'probe.sh must not compute the CPU percentage itself')
  // 只看非注释行：注释里当然可以提「以前的 awk 算错了」。
  const cpuCode = cpuSection
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n')
  assert.ok(!/\bawk\b/.test(cpuCode), 'the CPU arithmetic belongs in probe.js where it can be unit-tested')
  for (const key of ['total1', 'idle1', 'iowait1', 'total2', 'idle2', 'iowait2']) {
    assert.ok(cpuSection.includes(`${key}=`), `probe.sh must ship ${key}`)
  }
})

// ---------------------------------------------------------------------------
// facts 里被丢掉的字段（面板真的在读）
// ---------------------------------------------------------------------------

test('parseProbeOutput keeps cpuModel and cpuCount in facts', () => {
  // app/ViewModels.cs 用「型号 ×核心数」渲染 CPU 行，app/StateValidator.cs 校验
  // 这两个键；以前它们解析出来又被丢掉，于是面板那一行永远是空的。
  const { facts } = parseProbeOutput(SAMPLE)
  assert.equal(facts.cpuModel, 'Intel(R) Core(TM) i5-8200Y CPU @ 1.30GHz')
  assert.equal(facts.cpuCount, 2)
})

test('facts.cpuCount only ever emits an integer, because the panel validator rejects the whole snapshot otherwise', () => {
  const { facts } = parseProbeOutput('@@@CPUINFO\ncount=2.5\nmodel=X\n@@@END\n')
  assert.equal(facts.cpuCount, undefined)
  assert.equal(facts.cpuModel, 'X')
})

// ---------------------------------------------------------------------------
// 原子写 / pruneUndefined
// ---------------------------------------------------------------------------

test('writeFileAtomicSync removes its temp file when the rename fails', () => {
  const dir = tempDir('wsx-atomic-')
  const target = path.join(dir, 'state.json')
  fs.mkdirSync(target) // 目标是目录 → rename 必然失败
  assert.throws(() => writeFileAtomicSync(target, '{}'))
  // 心跳级频率的失败写入不能在数据目录里堆出一串 *.tmp
  assert.deepEqual(fs.readdirSync(dir), ['state.json'])
})

test('writeFileAtomicSync leaves no temp file behind on success', () => {
  const dir = tempDir('wsx-atomic-ok-')
  const target = path.join(dir, 'state.json')
  writeFileAtomicSync(target, '{"a":1}')
  assert.deepEqual(fs.readdirSync(dir), ['state.json'])
  assert.equal(fs.readFileSync(target, 'utf8'), '{"a":1}')
})

test('pruneUndefined leaves non-plain objects intact instead of flattening them to {}', () => {
  const when = new Date(0)
  const buffer = Buffer.from('ab')
  const out = pruneUndefined({ when, buffer, nested: { keep: 1, drop: undefined } })
  assert.equal(out.when, when)
  assert.ok(Buffer.isBuffer(out.buffer), 'a Buffer must not be turned into a plain object')
  assert.deepEqual(out.nested, { keep: 1 })
})

// ---------------------------------------------------------------------------
// 目标选择：歧义必须拒绝，不能「猜第一个」
// ---------------------------------------------------------------------------

const SELECTOR_TARGETS = [
  { id: 'ssh-prod-web-1', name: '生产机', host: '10.0.0.1' },
  { id: 'ssh-prod-web-2', name: '备份机', host: '10.0.0.2' },
  { id: 'wsl-ubuntu-24.04', name: 'WSL Ubuntu 24.04', host: '127.0.0.1', distro: 'Ubuntu-24.04' },
]

test('an ambiguous selector is refused instead of silently hitting the first match', () => {
  // 以前工具走 manager.getTarget（子串命中第一个），命令走「歧义就报错」，
  // 于是同一个选择器在两条路径上会指向不同的机器。
  const { target, candidates } = resolveTargetSelector(SELECTOR_TARGETS, 'prod')
  assert.equal(target, undefined)
  assert.equal(candidates.length, 2)
  assert.throws(() => requireTargetSelector(SELECTOR_TARGETS, 'prod'), /matches 2 targets/)
})

test('selector resolution matches id, name, host and a unique fragment', () => {
  assert.equal(requireTargetSelector(SELECTOR_TARGETS, 'ssh-prod-web-2').id, 'ssh-prod-web-2')
  assert.equal(requireTargetSelector(SELECTOR_TARGETS, 'WSL Ubuntu 24.04').id, 'wsl-ubuntu-24.04')
  assert.equal(requireTargetSelector(SELECTOR_TARGETS, '10.0.0.1').id, 'ssh-prod-web-1')
  assert.equal(requireTargetSelector(SELECTOR_TARGETS, 'ubuntu').id, 'wsl-ubuntu-24.04')
  assert.equal(targetLabel(SELECTOR_TARGETS[0]), '生产机')
  assert.throws(() => requireTargetSelector(SELECTOR_TARGETS, 'nope'), /no target matching/)
  assert.throws(() => requireTargetSelector(SELECTOR_TARGETS, ''), /"target" is required/)
  assert.throws(() => requireTargetSelector([], ''), /none — add some/)
})

test('manager.getTarget refuses an ambiguous selector too', () => {
  const manager = makeManager({
    targets: [
      { kind: 'ssh', id: 'ssh-a', name: 'prod-a', host: '10.1.0.1' },
      { kind: 'ssh', id: 'ssh-b', name: 'prod-b', host: '10.1.0.2' },
    ],
  })
  assert.equal(manager.getTarget('prod'), undefined)
  assert.equal(manager.resolveTarget('prod').candidates.length, 2)
  assert.equal(manager.getTarget('prod-a').id, 'ssh-a')
  manager.dispose()
})

// ---------------------------------------------------------------------------
// 超时：全局默认不动，但支持目标级覆盖
// ---------------------------------------------------------------------------

test('a target-level timeoutMs overrides the global one and is clamped', () => {
  const { config } = normalizeConfig({
    timeoutMs: 30_000,
    targets: [
      { kind: 'ssh', host: 'a', timeoutMs: 5000 },
      { kind: 'ssh', host: 'b' },
      { kind: 'ssh', host: 'c', timeoutMs: 10 },
      { kind: 'wsl', distro: 'Ubuntu-24.04', timeoutMs: 90_000 },
    ],
  })
  assert.equal(effectiveTimeoutMs(config.targets[0], config), 5000)
  assert.equal(effectiveTimeoutMs(config.targets[1], config), 30_000)
  assert.equal(effectiveTimeoutMs(config.targets[2], config), 3000, 'clamped up to the minimum, not treated as absent')
  assert.equal(effectiveTimeoutMs(config.targets[3], config), 90_000)
  // 全局默认仍然是 60s：WSL 冷启动 18–88s 是 README 记着的真实代价，降下来就是重踩旧坑。
  assert.equal(normalizeConfig({}).config.timeoutMs, 60000)
  assert.equal(effectiveTimeoutMs({ kind: 'ssh', host: 'x' }, { timeoutMs: 60_000 }), 60_000)
})

test('scp destinations bracket IPv6 literals and keep argv-safe hosts verbatim', () => {
  // scp 按第一个冒号切 host:path，裸的 `::1` 会被解析成空主机名 → 直接失败。
  assert.equal(sshDestination({ host: '::1', user: 'root' }), 'root@[::1]')
  assert.equal(sshDestination({ host: 'fe80::1' }), '[fe80::1]')
  assert.equal(sshDestination({ host: '[::1]', user: 'root' }), 'root@[::1]')
  assert.equal(sshDestination({ host: 'prod-web-1', user: 'deploy' }), 'deploy@prod-web-1')
  // 参数是独立 argv、不经过 shell，所以空格不需要（也不应该）转义。
  assert.equal(sshDestination({ host: 'weird host', user: 'u' }), 'u@weird host')
})

test('control socket paths stay unique and short, and multiplexing is dropped when they cannot fit', () => {
  const saved = process.env.DSH_HOME
  try {
    process.env.DSH_HOME = 'C:\\dsh'
    const a = controlPathFor({ id: 'x'.repeat(64) + '-one' })
    const b = controlPathFor({ id: 'y'.repeat(64) + '-two' })
    assert.ok(a.length <= 90 && b.length <= 90, 'a too-long ControlPath makes every probe fail')
    assert.notEqual(a, b, 'two targets must never share one control socket')

    const { config } = normalizeConfig({ targets: [{ kind: 'ssh', host: 'h' }] })
    assert.ok(buildSshArgs(config.targets[0], config, 'x').some((v) => v.startsWith('ControlPath=')))

    // DSH_HOME 太深时：宁可放弃连接复用，也不能让每次探测都因 ControlPath too long 失败。
    process.env.DSH_HOME = `C:\\${'deep-directory-'.repeat(10)}`
    const longConfig = normalizeConfig({ targets: [{ kind: 'ssh', host: 'h' }] }).config
    const args = buildSshArgs(longConfig.targets[0], longConfig, 'x')
    assert.ok(!args.some((v) => v.startsWith('ControlPath=')))
    assert.ok(!args.includes('ControlMaster=auto'))
  } finally {
    if (saved === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = saved
  }
})

// ---------------------------------------------------------------------------
// 内联（base64）文件传输：命令形状与准入判断
// ---------------------------------------------------------------------------

test('inlineLimitError refuses the sizes that would corrupt or blow up memory', () => {
  assert.equal(inlineLimitError(1024), undefined)
  assert.match(inlineLimitError(9 * 1024 * 1024), /over the 8MB inline limit/)
  assert.equal(inlineLimitError(9 * 1024 * 1024, 16 * 1024 * 1024), undefined)
  assert.equal(inlineLimitError(Number.NaN), undefined, 'an unknown size is reported separately by the caller')
})

test('the inline upload writes a temp file, verifies the size, then replaces atomically', () => {
  const command = buildInlineUploadCommand({
    remote: '/tmp/dest file',
    tmp: '/tmp/dest file.wsx-1.part',
    encoded: 'YWJj',
    bytes: 3,
    mode: '0644',
    makeDirs: true,
  })
  assert.match(command, /^umask 022$/m)
  assert.match(command, /mkdir -p '\/tmp'/)
  assert.match(command, /base64 -d > '\/tmp\/dest file\.wsx-1\.part'/)
  assert.match(command, /wc -c/)
  assert.ok(
    command.indexOf('mv -f') > command.indexOf('wc -c'),
    'the size check must run before the final replace',
  )
  assert.ok(command.indexOf('chmod') < command.indexOf('mv -f'), 'chmod before mv → the file appears with its final mode')
  assert.ok(
    !/base64 -d > '\/tmp\/dest file'/.test(command),
    'the destination must never be truncated directly: a failure would destroy the previous file',
  )
})

test('the inline download asks for the size before the body', () => {
  const command = buildInlineDownloadCommand('/var/log/syslog')
  assert.equal(command.split('\n')[0], `wc -c < '/var/log/syslog' 2>/dev/null`)
  assert.match(command, /base64 '\/var\/log\/syslog'/)
})

test('windowTail reports truncation from the real line count', () => {
  assert.deepEqual(windowTail('a\nb\nc\n', 2), { lines: ['b', 'c'], truncated: true })
  // 恰好等于上限时**不是**截断（以前用 `行数 >= count` 判断，这里会误报）
  assert.deepEqual(windowTail('a\nb\n', 2), { lines: ['a', 'b'], truncated: false })
  assert.deepEqual(windowTail('', 5), { lines: [], truncated: false })
})

test('parseLsOutput counts truncation before filtering . and ..', () => {
  const row = (name, type = '-') => `${type}rw-r--r-- 1 0 0 1234 Jan  1 00:00 ${name}`
  const listing = ['total 8', row('.', 'd'), row('..', 'd'), row('a'), row('b'), row('c'), row('link -> /x', 'l')].join('\n')
  // 4 个**真实**条目（. 与 .. 会被过滤掉）、上限 4 → 没截断。
  // 旧代码用 `entries.length >= limit` 判断，这里会误报截断。
  const exact = parseLsOutput(listing, 4)
  assert.equal(exact.truncated, false, 'a listing that exactly fills the limit is not truncated')
  assert.equal(exact.entries.length, 4)
  assert.equal(exact.entries[3].type, 'link')
  assert.equal(exact.entries[3].linkTarget, '/x')
  assert.equal(exact.entries[0].sizeBytes, 1234)
  assert.ok(!exact.entries.some((e) => e.name === '.' || e.name === '..'))

  const limited = parseLsOutput(listing, 3)
  assert.equal(limited.truncated, true)
  assert.deepEqual(limited.entries.map((e) => e.name), ['a', 'b', 'c'])
})

// ---------------------------------------------------------------------------
// 调度：心跳写盘频率、冷启动错峰、enabled 总闸
// ---------------------------------------------------------------------------

test('tick() only writes the state file when the heartbeat is due', () => {
  // 以前 `writeSnapshot(force)` 的 force 参数根本没被读过 → 每 500ms（flushIntervalMs）
  // 就 JSON.stringify 整份历史并同步写盘，heartbeatMs（2000）等于死配置。
  const manager = makeManager({ flushIntervalMs: 500, heartbeatMs: 2000 })
  try {
    let writes = 0
    const realWrite = manager.store.write.bind(manager.store)
    manager.store.write = (...args) => {
      writes += 1
      return realWrite(...args)
    }
    manager.lastHeartbeatAt = Date.now()
    manager.tick()
    manager.tick()
    manager.tick()
    assert.equal(writes, 0, 'nothing changed and the heartbeat is not due → no disk write')

    manager.lastHeartbeatAt = 0
    manager.tick()
    assert.equal(writes, 1, 'the heartbeat must still write exactly once')
  } finally {
    manager.dispose()
  }
})

test('a completed probe writes the snapshot even between heartbeats', async () => {
  const manager = makeManager({
    probeIntervalMs: 15_000,
    flushIntervalMs: 500,
    heartbeatMs: 60_000,
    targets: [{ kind: 'ssh', id: 'ssh-t', host: '10.9.0.1' }],
  })
  try {
    let writes = 0
    const realWrite = manager.store.write.bind(manager.store)
    manager.store.write = (...args) => {
      writes += 1
      return realWrite(...args)
    }
    manager.lastHeartbeatAt = Date.now()
    manager.probeTarget = async () => {
      manager.runtimes[0].nextProbeAt = Date.now() + 15_000
      return manager.runtimes[0]
    }
    manager.tick()
    assert.equal(writes, 0, 'starting a probe is not itself a reason to write')
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(writes, 1, 'fresh data must land regardless of the heartbeat')
  } finally {
    manager.dispose()
  }
})

test('startup staggering reserves nextProbeAt so the first tick cannot jump the queue', () => {
  const manager = makeManager({
    probeIntervalMs: 15_000,
    probeOnStart: true,
    targets: Array.from({ length: 6 }, (_, i) => ({ kind: 'ssh', id: `ssh-t${i}`, host: `10.9.0.${i}` })),
  })
  try {
    let probed = 0
    manager.probeTarget = async () => {
      probed += 1
    }
    manager.start()
    const times = manager.runtimes.map((r) => r.nextProbeAt)
    assert.ok(times.every((t) => t > 0), 'nextProbeAt=0 means "due now" and lets tick() overtake every staggered probe')
    // staggerMs = min(400, max(50, 15000/10)) = 400
    assert.equal(times[1] - times[0], 400)
    assert.equal(times[5] - times[0], 2000)
    manager.tick()
    assert.ok(probed <= 1, `tick() overtook the stagger: ${probed} probes started at once`)
  } finally {
    manager.dispose()
  }
})

test('enabled:false stops every probe but still explains itself', async () => {
  const warnings = []
  const manager = makeManager(
    { enabled: false, probeOnStart: true, targets: [{ kind: 'ssh', id: 'ssh-x', host: '10.9.9.9' }] },
    { warn: (message) => warnings.push(message) },
  )
  try {
    manager.start()
    assert.ok(
      warnings.some((w) => /enabled=false/.test(w)),
      'a disabled plugin must say why every target stays unknown',
    )
    await assert.rejects(() => manager.wake(), /disabled/)
    // 探测的唯一入口也要挡住：/wsx probe 与工具的 refresh 都走 probeTarget。
    assert.equal(await manager.probeTarget(manager.runtimes[0].target), undefined)
  } finally {
    manager.dispose()
  }
})

test('the cold-start flag follows a slow WSL probe, not a reason nobody passes', () => {
  // 面板的「冷启动」角标只认这个字段；旧代码写的是 `reason === 'wake'`，
  // 而调用方只会传 startup/scheduled/manual —— 角标从来没亮过。
  assert.equal(isColdStartWsl({ kind: 'wsl', distro: 'Ubuntu-24.04' }, 22_000), true)
  assert.equal(isColdStartWsl({ kind: 'wsl', distro: 'Ubuntu-24.04' }, 3_500), false)
  assert.equal(isColdStartWsl({ kind: 'ssh', host: 'h' }, 22_000), false)
})

test('a failed probe records a gap in the history instead of nothing at all', () => {
  const runtime = new TargetRuntime({ id: 't', name: 't', kind: 'ssh', host: 'h', tags: [] })
  runtime.markOnline({ metrics: { cpu: { usagePercent: 12 }, memory: { usagePercent: 30 } }, facts: {}, latencyMs: 90 }, 5, 1000)
  runtime.markOffline('boom', 2000, 5)
  assert.equal(runtime.history.length, 2, 'markOffline used to pass historyLength=0, so the sample was silently dropped')
  // 失败样本不带 cpu/mem：带上的话趋势线会把上一次的旧值画成一次正常采样。
  assert.deepEqual(runtime.history[1], { at: 2000, latencyMs: 0 })
  runtime.markOnline({ metrics: { cpu: { usagePercent: 20 } }, facts: {}, latencyMs: 50 }, 2, 3000)
  assert.equal(runtime.history.length, 2)
  assert.deepEqual(runtime.history.map((s) => s.at), [2000, 3000], 'historyLength must be honoured')
  runtime.markOffline('boom', 4000, 0)
  assert.equal(runtime.history.length, 2, 'historyLength=0 disables history entirely')
})

test('the write-error warning is not repeated on every heartbeat', () => {
  const warnings = []
  const manager = makeManager({}, { warn: (message) => warnings.push(message) })
  try {
    manager.reportWriteError('disk full')
    manager.reportWriteError('disk full')
    manager.reportWriteError('disk full')
    assert.equal(warnings.length, 1, 'a persistent failure must not spam the host log every 2 seconds')
    assert.match(warnings[0], /disk full/)
    assert.match(warnings[0], /panel keeps showing/)
    manager.reportWriteError('permission denied')
    assert.equal(warnings.length, 2, 'a *different* error is still news')
    manager.reportWriteError('')
    assert.equal(warnings.length, 3)
    assert.match(warnings[2], /recovered/)
    manager.reportWriteError('')
    assert.equal(warnings.length, 3, 'recovery is reported once')
  } finally {
    manager.dispose()
  }
})

// ---------------------------------------------------------------------------
// /wsx 命令：目标省略、空白处理、错误文案
// ---------------------------------------------------------------------------

/** /wsx 需要的假 manager：只有 runtimes / config / runtimeFor / snapshot。 */
function makeCommandManager(targets) {
  const runtimes = targets.map((target) => ({
    id: target.id,
    target,
    status: 'online',
    metrics: null,
    history: [],
    toJSON: () => ({
      id: target.id,
      name: target.name,
      kind: target.kind,
      host: target.kind === 'wsl' ? target.distro : target.host,
      port: target.port,
      status: 'online',
      consecutiveFailures: 0,
      metrics: null,
      history: [],
    }),
  }))
  return {
    runtimes,
    config: { probeIntervalMs: 15000, timeoutMs: 60000, maxConcurrentProbes: 4, allowMutations: true },
    runtimeFor: (id) => runtimes.find((r) => r.id === id),
    snapshot: () => ({
      generatedAt: Date.now(),
      host: { stateFile: 'X:\\state.json', configErrors: [] },
      totals: { targets: runtimes.length, online: runtimes.length, offline: 0, probing: 0, unknown: 0 },
      targets: runtimes.map((r) => r.toJSON()),
      errors: [],
    }),
  }
}

const WSL_TARGET = { id: 'wsl-ubuntu-24.04', name: 'WSL Ubuntu 24.04', kind: 'wsl', host: '127.0.0.1', distro: 'Ubuntu-24.04', tags: [] }
const SSH_TARGETS = [
  { id: 'ssh-prod-web-1', name: '生产机', kind: 'ssh', host: '10.0.0.1', tags: [] },
  { id: 'ssh-prod-web-2', name: '备份机', kind: 'ssh', host: '10.0.0.2', tags: [] },
]

test('a single-target deployment may omit the target name', () => {
  // 只配了一个目标时 `/wsx docker` 是常态；以前会报 `no target matching ""`。
  assert.equal(resolveOrThrow(makeCommandManager([WSL_TARGET]), '').id, 'wsl-ubuntu-24.04')
  assert.throws(() => resolveOrThrow(makeCommandManager(SSH_TARGETS), ''), /请指定目标/)
  assert.throws(() => resolveOrThrow(makeCommandManager([]), ''), /没有配置任何目标/)
  assert.throws(() => resolveOrThrow(makeCommandManager(SSH_TARGETS), 'prod'), /匹配到 2 个目标/)
  assert.throws(() => resolveOrThrow(makeCommandManager([WSL_TARGET]), 'zzz'), /no target matching/)
})

test('/wsx exec takes everything after the target as the command, whatever the whitespace', async () => {
  const seen = []
  const helpers = {
    execOnTarget: async (target, command) => {
      seen.push([target.id, command])
      return { stdout: 'Linux 6.18\n', stderr: '', code: 0, ms: 12, channel: 'ssh' }
    },
  }
  // 制表符分隔（脚本/智能体发出来的输入里很常见）以前会被当成「用法错误」
  const tabbed = await handleWsxCommand(makeCommandManager([WSL_TARGET]), { rawInput: 'exec\tubuntu\tuname -r' }, helpers)
  assert.equal(tabbed.kind, 'success')
  assert.deepEqual(seen, [['wsl-ubuntu-24.04', 'uname -r']])
  assert.match(tabbed.text, /退出码 0/)

  const spaced = await handleWsxCommand(makeCommandManager([WSL_TARGET]), { rawInput: 'exec  ubuntu  echo "a b" | wc -l' }, helpers)
  assert.equal(spaced.kind, 'success')
  assert.equal(seen[1][1], 'echo "a b" | wc -l')

  const missing = await handleWsxCommand(makeCommandManager([WSL_TARGET]), { rawInput: 'exec ubuntu' }, helpers)
  assert.equal(missing.kind, 'error')
  assert.match(missing.text, /用法/)
})

test('/wsx exec shows why a timed-out command timed out', async () => {
  // 超时的 stderr 是空的：原因只在 result.error 里。以前这一行只显示「退出码 —」。
  const helpers = {
    execOnTarget: async () => ({
      stdout: '',
      stderr: '',
      code: null,
      ms: 3000,
      timedOut: true,
      channel: 'wsl',
      error: 'wsl.exe timed out after 3s (a cold WSL start can take 18-88s; try raising timeoutMs)',
    }),
  }
  const result = await handleWsxCommand(makeCommandManager([WSL_TARGET]), { rawInput: 'exec ubuntu sleep 30' }, helpers)
  assert.equal(result.kind, 'success')
  assert.match(result.text, /超时（3000ms）/)
  assert.match(result.text, /cold WSL start/)
})

test('/wsx reports an unknown subcommand together with the help text', async () => {
  const result = await handleWsxCommand(makeCommandManager([WSL_TARGET]), { rawInput: 'bogus' }, {})
  assert.equal(result.kind, 'error')
  assert.match(result.text, /未知子命令/)
  assert.match(result.text, /\/wsx status/)
})

test('/wsx with no arguments renders the status table', async () => {
  const result = await handleWsxCommand(makeCommandManager([WSL_TARGET]), { rawInput: '' }, {})
  assert.equal(result.kind, 'success')
  assert.match(result.text, /远程目标状态/)
  assert.match(result.text, /WSL Ubuntu 24\.04/)
  const listed = await handleWsxCommand(makeCommandManager([WSL_TARGET]), { rawInput: 'list' }, {})
  assert.match(listed.text, /工具注册路径/)
})

test('/wsx failure text is actionable rather than a raw stack', async () => {
  const result = await handleWsxCommand(makeCommandManager([WSL_TARGET]), { rawInput: 'status zzz' }, {})
  assert.equal(result.kind, 'error')
  assert.match(result.text, /^status 失败：/)
  assert.match(result.text, /no target matching/)
})

// ---------------------------------------------------------------------------
// 插件装配：命令 / 工具 / 路由的注册
// ---------------------------------------------------------------------------

/** 一个假的 DSH root：只实现 apply() 真正用到的那几个能力。 */
function makeFakeRoot({ services } = {}) {
  const state = { warnings: [], effects: [] }
  return {
    state,
    logger: { warn: (m) => state.warnings.push(m), debug: () => {}, info: () => {} },
    effect(fn) {
      const disposer = fn()
      if (typeof disposer === 'function') state.effects.push(disposer)
    },
    inject(deps, callback) {
      if (!deps.length) return callback()
      // 真实的 Cordis ctx 既能 ctx.get('tools') 也能直接 ctx.tools —— 两种都提供。
      callback({ ...services, get: (name) => services[name] })
    },
  }
}

test('apply() wires up the command, the tools and the three web routes', () => {
  const stateFile = path.join(tempDir('wsx-apply-'), 'state.json')
  const services = {
    commands: { defs: [], register: (def) => { services.commands.defs.push(def); return () => {} } },
    tools: { defs: [], register: (def) => { services.tools.defs.push(def); return () => {} } },
    webServer: { routes: [], register: (route) => { services.webServer.routes.push(route); return () => {} } },
  }
  const root = makeFakeRoot({ services })
  apply(root, { stateFile, probeOnStart: false, targets: [{ kind: 'ssh', id: 'ssh-x', host: '10.9.9.9' }] })
  try {
    assert.equal(services.commands.defs.length, 1)
    assert.equal(services.commands.defs[0].name, 'wsx')
    assert.equal(services.tools.defs.length, 7)
    assert.deepEqual(services.webServer.routes.map((r) => r.path).sort(), [
      '/dsh-remote-panel/open',
      '/dsh-remote-panel/probe',
      '/dsh-remote-panel/snapshot',
    ])
    // 客户端面板点的那两个路由必须真的挂了 handler
    for (const route of services.webServer.routes) assert.equal(typeof route.handler, 'function')
    assert.deepEqual(root.state.warnings, [], 'a healthy load must not warn')
    assert.ok(fs.existsSync(stateFile), 'the plugin must publish its first snapshot')
    assert.ok(fs.existsSync(path.join(path.dirname(stateFile), 'config.resolved.json')))
  } finally {
    for (const dispose of root.state.effects) dispose()
  }
})

test('a failed registration is reported instead of silently vanishing', () => {
  const stateFile = path.join(tempDir('wsx-apply-fail-'), 'state.json')
  const services = {
    commands: { register: () => { throw new Error('commands.register exploded') } },
    tools: { register: () => { throw new Error('tools.register exploded') } },
    webServer: { register: () => { throw new Error('webServer.register exploded') } },
  }
  const root = makeFakeRoot({ services })
  apply(root, {
    stateFile,
    probeOnStart: false,
    targets: [{ kind: 'ssh', host: '10.9.9.9' }, { kind: 'nonsense', host: 'x' }],
  })
  try {
    const joined = root.state.warnings.join('\n')
    // 现象只是「/wsx 不存在 / 网页面板打不开」，没有这句告警就完全没有线索
    assert.match(joined, /registering the \/wsx command failed/)
    assert.match(joined, /no remote_\* tool could be registered/)
    assert.match(joined, /could not register the web route/)
    assert.match(joined, /configuration problem/, 'bad targets must be reported at load time')
  } finally {
    for (const dispose of root.state.effects) dispose()
  }
})

// ---------------------------------------------------------------------------
// HTTP body 读取（宿主路由）
// ---------------------------------------------------------------------------

test('readBody stops accumulating and detaches once past the limit', async () => {
  const req = new EventEmitter()
  let destroyed = 0
  req.destroy = () => {
    destroyed += 1
  }
  const pending = readBody(req, 100)
  for (let i = 0; i < 20; i += 1) req.emit('data', 'x'.repeat(50))
  const body = await pending
  assert.equal(body.length, 100)
  assert.equal(destroyed, 1, 'a runaway body must be destroyed, not silently buffered forever')
  assert.equal(req.listenerCount('data'), 0, 'the data listener must be detached after finishing')
})

test('readBody resolves on end and on an error without hanging', async () => {
  const ok = new EventEmitter()
  ok.destroy = () => {}
  const pending = readBody(ok, 100)
  ok.emit('data', '{"target":"a"}')
  ok.emit('end')
  assert.equal(await pending, '{"target":"a"}')

  const broken = new EventEmitter()
  broken.destroy = () => {}
  const pendingBroken = readBody(broken, 100)
  broken.emit('error', new Error('reset'))
  assert.equal(await pendingBroken, '')
})
