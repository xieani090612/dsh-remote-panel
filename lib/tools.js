/**
 * dsh-remote-panel —— 原生 DSH 工具（注册层）
 * ============================================================================
 * 这个文件只做两件事：
 *   1. 声明 `TOOL_SPECS` —— 每个工具的名字、描述、参数方言、输出渲染；
 *   2. 把它们注册进 DSH 的工具注册表。
 *
 * **实现逻辑不在这里**，在 `remote-ops.js`。MCP 服务器（`mcp-server.js`）复用
 * 同一份 `TOOL_SPECS` 与同一批实现，所以「模型从 DSH 调」与「外部 MCP 客户端调」
 * 走的是完全相同的校验与写操作闸门，不会出现两边行为不一致。
 *
 * 关于注册路径的容错：
 *   官方 `defineTool`（`@deepseek-ai/dsh-tools`）会额外做 schema 规范化与参数校验；
 *   但 `@deepseek-ai/*` 包**只存在于 app.asar 内部**，第三方插件的 ESM import
 *   能否解析取决于加载器实现，不该赌。所以这里：
 *     - 能 import 到 → 优先用 `defineTool`；
 *     - import 不到或它拒绝 → 退回 `ctx.tools.register` 的原始 JSON Schema 路径。
 *   两条路径的**参数方言只有一个**（本文件顶部那套），由 `projectParameters()`
 *   负责翻译，所以不存在「两套写法」的维护负担。
 */

import {
  remoteDocker,
  remoteExec,
  remoteFiles,
  remotePanel,
  remoteProcesses,
  remoteServices,
  remoteStatus,
} from './remote-ops.js'
import { flatten } from './util.js'

// ---------------------------------------------------------------------------
// 注册路径：defineTool（优先）→ 原始 JSON Schema（兜底）
// ---------------------------------------------------------------------------

let defineToolImpl = null
let defineToolState = 'unresolved'
try {
  const mod = await import('@deepseek-ai/dsh-tools')
  if (typeof mod?.defineTool === 'function') {
    defineToolImpl = mod.defineTool
    defineToolState = 'defineTool'
  } else {
    defineToolState = 'raw (defineTool export missing)'
  }
} catch (error) {
  defineToolState = `raw (defineTool unavailable: ${flatten(error?.message || error, 100)})`
}

/** 把单个属性从本文件的参数方言翻成标准 JSON Schema。 */
function propertyToJsonSchema(spec) {
  if (!spec || typeof spec !== 'object') return {}
  const out = {}
  for (const [key, value] of Object.entries(spec)) {
    if (key === 'required') continue // 方言里它表示「父对象需要这个键」
    if (key === 'items') {
      out.items = propertyToJsonSchema(value)
      out.type = 'array'
      continue
    }
    if (key === 'type' && value === 'json') continue // 任意 JSON = 省略 type
    out[key] = value
  }
  return out
}

/**
 * 把参数方言投影成标准 JSON Schema。
 *
 * 方言与 JSON Schema 的三处差异（别按直觉写）：
 *   - `required: true` 写在**属性**上，而不是父对象的数组；
 *   - 数组属性用 `items` 声明元素类型，不写 `type: 'array'`；
 *   - `type: 'json'` 表示「任意 JSON」。
 */
export function projectParameters(parameters) {
  const properties = {}
  const required = []
  for (const [key, spec] of Object.entries(parameters || {})) {
    if (!spec || typeof spec !== 'object') continue
    if (spec.required === true) required.push(key)
    const { required: _ignored, ...rest } = spec
    properties[key] = propertyToJsonSchema(rest)
  }
  return { type: 'object', properties, required, additionalProperties: false }
}

/** 输出的 schema 同样吃那套方言。 */
function projectValueSchema(schema) {
  if (!schema || typeof schema !== 'object') return { type: 'object', properties: {}, additionalProperties: true }
  if (schema.type === 'object' && schema.properties) {
    const { properties, ...rest } = schema
    return { ...rest, ...projectParameters(properties) }
  }
  return schema
}

/**
 * 统一的输出声明。
 * `data` 用 `type: 'json'`（任意结构）—— 各工具返回的形状差异很大，
 * 而模型真正读到的是 `render()` 产出的文本。
 */
const OUTPUT = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      ok: { type: 'boolean', required: true, description: 'Whether the operation succeeded.' },
      summary: { type: 'string', required: true, description: 'One-line human-readable result.' },
      data: { type: 'json', description: 'Structured payload; shape depends on the tool.' },
    },
  },
  render: (_args, value) => [
    { type: 'text', text: value?.ok === false ? `FAILED: ${value.summary}` : value.summary },
    ...(value?.data === undefined || value?.data === null
      ? []
      : [{ type: 'text', text: `\n\`\`\`json\n${JSON.stringify(value.data, null, 2)}\n\`\`\`` }]),
  ],
}

/** 目标参数在所有工具里长得一样，抽出来省得写八遍。 */
export const TARGET_PARAM = {
  type: 'string',
  required: true,
  description: 'Target id, name, hostname, or a unique fragment of any of those. Call remote_status to list them.',
}

// ---------------------------------------------------------------------------
// 工具清单（DSH 与 MCP 共用的唯一事实来源）
// ---------------------------------------------------------------------------

export const TOOL_SPECS = [
  {
    name: 'remote_status',
    description:
      'List the configured remote targets (local WSL distributions and SSH machines) with their live status: reachability, CPU, memory, disk, GPU, docker counts and last-probe latency. ' +
      'Start here before calling any other remote_* tool to learn the available target ids.',
    parameters: {
      target: { type: 'string', description: 'Optional: limit the report to one target.' },
      refresh: { type: 'boolean', description: 'Probe the target(s) now instead of reporting cached data.' },
    },
    run: remoteStatus,
  },
  {
    name: 'remote_exec',
    description:
      'Run one read-only command on a remote target over SSH (or inside a WSL distribution) and return its stdout, stderr and exit code. ' +
      'Use it for information the status probe does not cover (config files, logs, package versions, journalctl). ' +
      'The command runs through a POSIX shell on the target. Prefer remote_docker / remote_services / remote_processes / remote_files for those areas — they validate arguments and quote safely.',
    parameters: {
      target: TARGET_PARAM,
      command: { type: 'string', required: true, description: 'The shell command line to run on the target.' },
      timeoutMs: { type: 'integer', description: 'Override the configured timeout (3000-600000).' },
      maxBytes: { type: 'integer', description: 'Truncate captured stdout to this many bytes (default 65536).' },
    },
    run: remoteExec,
  },
  {
    name: 'remote_files',
    description:
      'Transfer files to and from a remote target, list a remote directory, or read a remote text file. ' +
      'Upload and download use scp and automatically fall back to a base64-over-SSH path on targets without sftp-server ' +
      '(that fallback is limited to 8MB per file and refuses larger ones rather than risk a truncated copy).',
    parameters: {
      target: TARGET_PARAM,
      operation: {
        type: 'string',
        required: true,
        enum: ['list', 'read', 'upload', 'download'],
        description: 'list = directory listing; read = read a text file; upload = local → remote; download = remote → local.',
      },
      remotePath: { type: 'string', description: 'Absolute POSIX path on the target. Required for every operation.' },
      localPath: { type: 'string', description: 'Local path. Required for upload and download.' },
      makeDirs: { type: 'boolean', description: 'upload only: create the remote parent directory.' },
      mode: { type: 'string', description: 'upload only: octal chmod to apply, e.g. "0644".' },
      overwrite: { type: 'boolean', description: 'download only: replace an existing local file.' },
      maxBytes: { type: 'integer', description: 'read only: maximum bytes to return (default 262144).' },
    },
    run: remoteFiles,
  },
  {
    name: 'remote_docker',
    description:
      'Inspect and control Docker on a remote target: list containers, read container logs, and start/stop/restart/pause containers. ' +
      'Mutating actions require allowMutations (enabled by default) and are refused when the plugin is configured read-only.',
    parameters: {
      target: TARGET_PARAM,
      operation: { type: 'string', required: true, enum: ['ps', 'logs', 'start', 'stop', 'restart', 'pause', 'unpause'] },
      container: { type: 'string', description: 'Container name or id. Required except for ps.' },
      all: { type: 'boolean', description: 'ps only: include stopped containers (default true).' },
      lines: { type: 'integer', description: 'logs only: how many trailing lines (default 100).' },
      since: { type: 'string', description: 'logs only: docker --since value, e.g. "30m".' },
      timeoutSec: { type: 'integer', description: 'stop/restart only: graceful timeout in seconds.' },
    },
    run: remoteDocker,
  },
  {
    name: 'remote_services',
    description:
      'List systemd (or sysvinit) service states on a remote target, and start/stop/restart/reload a service. ' +
      'Starting and stopping usually needs root; a permission failure is reported with that explanation.',
    parameters: {
      target: TARGET_PARAM,
      operation: { type: 'string', required: true, enum: ['status', 'start', 'stop', 'restart', 'reload'] },
      services: {
        items: { type: 'string' },
        description: 'status only: service names to check (defaults to the target config list, or ssh/sshd/docker/cron/nginx).',
      },
      service: { type: 'string', description: 'Service name. Required for the mutating operations.' },
    },
    run: remoteServices,
  },
  {
    name: 'remote_processes',
    description:
      'List the top processes on a remote target by CPU or memory, with an optional name filter. ' +
      'The kill action additionally requires confirm: true — it is refused otherwise, because killing by PID is irreversible.',
    parameters: {
      target: TARGET_PARAM,
      operation: { type: 'string', required: true, enum: ['list', 'kill'] },
      sort: { type: 'string', enum: ['cpu', 'mem'], description: 'list only: sort key (default cpu).' },
      limit: { type: 'integer', description: 'list only: how many rows (default 15).' },
      filter: { type: 'string', description: 'list only: case-insensitive substring match on the command line.' },
      pid: { type: 'integer', description: 'kill only: the PID to signal.' },
      signal: { type: 'string', description: 'kill only: signal name without SIG, e.g. TERM or KILL (default TERM).' },
      confirm: { type: 'boolean', description: 'kill only: must be true. Set it only after verifying the PID is the intended process.' },
    },
    run: remoteProcesses,
  },
  {
    name: 'remote_panel',
    description:
      'Show or bring to front the WinUI 3 status preview panel window, which renders the same snapshot as remote_status in an always-on-top desktop window. ' +
      'Also reports the snapshot state-file path.',
    parameters: {
      action: { type: 'string', required: true, enum: ['open', 'status'] },
    },
    run: remotePanel,
  },
]

// ---------------------------------------------------------------------------
// 注册
// ---------------------------------------------------------------------------

/**
 * 注册一个工具，返回 disposer。
 * 优先 `defineTool`（它会顺手做参数校验），不可用或拒绝时退回原始 JSON Schema 路径。
 */
export function makeTool(ctx, spec, helpers) {
  const definition = {
    name: spec.name,
    description: spec.description,
    parameters: spec.parameters,
    output: OUTPUT,
    execute: (args) => spec.run(helpers.manager, args ?? {}, helpers),
  }

  if (defineToolImpl) {
    try {
      return ctx.tools.register(defineToolImpl(definition))
    } catch (error) {
      // defineTool 对 schema 更严格；退回原始路径，并记录原因供诊断。
      defineToolState = `raw (defineTool rejected ${spec.name}: ${flatten(error?.message || error, 140)})`
    }
  }

  return ctx.tools.register({
    ...definition,
    parameters: projectParameters(spec.parameters),
    output: { ...OUTPUT, schema: projectValueSchema(OUTPUT.schema) },
  })
}

/**
 * 注册全部工具，返回 disposer 数组。调用方负责在 `ctx.effect` 里收尾。
 */
export function registerRemoteTools(ctx, manager, helpers) {
  const shared = { ...helpers, manager }
  const disposers = []
  for (const spec of TOOL_SPECS) {
    disposers.push(makeTool(ctx, spec, shared))
  }
  return disposers
}

/** 诊断用：当前实际走的是哪条注册路径。 */
export function toolRegistrationState() {
  return defineToolState
}

export { OUTPUT }
