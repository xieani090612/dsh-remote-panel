# MCP 服务器

<!-- 中文 | English -->
**中文** ｜ [English](#english)

如何从任意 MCP 客户端访问同一批远程/WSL 目标——通过内置的零依赖 stdio 服务器 `bin/mcp-server.js`。

这个服务器不是第二份实现。它导入的正是进程内 `remote_*` agent 工具所用的同一份 `TOOL_SPECS` 和同一个操作层（`lib/remote-ops.js`），所以参数校验、名称解析和每一道安全闸门在两边行为完全一致。

---

## 它是什么

| | |
| --- | --- |
| 入口 | `bin/mcp-server.js`（同时以 `dsh-remote-panel-mcp` bin 暴露） |
| 传输 | stdio，换行分隔的 JSON-RPC 2.0（每行一条消息） |
| 依赖 | 无 —— 只用 Node 内置模块，没有构建步骤 |
| 需要 | Node.js 20 或更高版本 |
| DSH 中的服务器名 | `remote_panel` → 工具呈现为 `mcp__remote_panel__<toolname>` |
| 会写状态吗？ | **不会。** MCP 进程只读取状态文件（`writeState: false`），因此它永远不可能与 host 插件的心跳竞态。 |
| stdout | **仅**协议 JSON |
| stderr | 所有诊断信息（`[dsh-remote-panel mcp] ...`） |

> 如果你要改动这个文件，唯一要紧的规矩是：**除了协议 JSON，绝不要往 stdout 写任何东西。** 一个多余的字符就会打断会话。日志请写 stderr。

### 为什么要有它

DSH 内置了 `@modelcontextprotocol/client` 和 `.../core`，但没有 server 包，而本插件刻意保持零依赖。MCP 的 stdio 传输足够简单——每行一条 JSON-RPC 消息——直接实现它比引入一个 SDK 更可控。

---

## 注册它

`cordis.patch.yml` 里已经包含一段 insert，用 DSH 自带的 MCP 客户端挂载这个服务器：

```yaml
- id: mcp-remote-panel
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: remote_panel
    transport: stdio
    command: !!js process.execPath
    args: !!js "process.env.DSH_PROFILE_DIR ? [process.env.DSH_PROFILE_DIR + '/node_modules/dsh-remote-panel/bin/mcp-server.js'] : []"
    cwd: !!js "process.env.DSH_PROFILE_DIR || process.cwd()"
    failOnStartupError: false
    toolCallTimeoutMs: 120000
```

值得知道的几点：

- 路径由 `process.execPath` 和 `%DSH_PROFILE_DIR%` 拼出来，而不是硬编码的绝对路径，因此 `link:` 安装和复制安装都能用，也不会有任何家目录路径落进已发布的包里。
- `failOnStartupError: false` —— 一个连不通的目标不该把 DSH 的启动拖垮。探测失败由工具照常上报。
- `toolCallTimeoutMs: 120000` —— 刻意给得宽松，因为一个冷启动的 WSL 发行版单次调用就能耗掉 18–88 秒。
- **不想要 MCP 就删掉整段。** `/wsx`、`remote_*` 工具和面板都不受影响。

改完 patch 要重启 DSH。服务器是一个子进程，所以改动 `bin/mcp-server.js` 同样需要重启（否则旧的子进程会一直跑下去）。

如果想从*另一个* MCP 客户端使用这个服务器，自行启动它，然后在它的 stdin/stdout 上说 JSONL 即可。不需要任何参数。

---

## 配置发现

目标来自 **host 插件的 resolved config**，而不是另一份副本。服务器按顺序尝试：

| # | 来源 | 说明 |
| --- | --- | --- |
| 1 | `DSH_WSX_CONFIG` | 内联 JSON 字符串。临时覆盖和测试时很方便。 |
| 2 | `DSH_WSX_CONFIG_FILE` | 指向一个 JSON 文件的路径。 |
| 3 | `$DSH_HOME/remote-panel/config.resolved.json` | 由 host 插件在每次启动时写入，因此 MCP 和 DSH 看到的永远是同一份目标列表。 |

未设置该环境变量时，`$DSH_HOME` 默认为 `%USERPROFILE%\.dsh`。

第 3 步的文件把载荷包成 `{ generatedAt, stateFile, config }`。来源 1 和 2 既可以是这种包装形式，也可以是裸的 `{ ... }` 配置对象——加载器两种都接受。要是找不到任何可用配置，服务器以默认值启动，并向 stderr 打印
`(defaults — no targets configured)`；此时 `remote_status` 报告零个目标，而不是失败。

启动时，服务器把配置来源、状态文件、解析出的目标 id 以及任何配置问题记到 stderr，然后**异步**发起一次初始探测——协议握手绝不会被一个慢目标卡住。

---

## 协议面

| 方法 | 行为 |
| --- | --- |
| `initialize` | 返回 `protocolVersion`、`capabilities.tools.listChanged: false`、`serverInfo` 和一段简短的 `instructions` 字符串。如果客户端请求的版本是本服务器认识的（`2024-11-05`、`2024-10-07`），就原样回显该版本；否则用自己的默认版本 `2024-11-05` 作答。不支持的请求**绝不会**被确认。 |
| `ping` | 返回 `{}`。 |
| `tools/list` | 返回与 `remote_*` 相同的七个工具，带标准 JSON Schema `inputSchema`。 |
| `tools/call` | 运行该工具并返回 MCP `content` 块（见下）。 |
| `resources/list` | 返回空列表——本服务器不暴露任何 resource。 |
| `prompts/list` | 返回空列表。 |
| 其他任何方法 | JSON-RPC 错误 `-32601` `Method not found: <method>`。 |
| 无法解析的行 | JSON-RPC 错误 `-32700` `Parse error: ...`，id 为 `null`（id 已无法恢复）。 |
| 通知（没有 `id`） | 不回复。`notifications/initialized` 只是记一条日志。 |

对一个不存在的名字发起 `tools/call` **不算** JSON-RPC 错误：它作为普通结果返回，带 `isError: true`，并在消息里列出可用的工具名。

### 结果形态

每次成功调用都返回一到两个文本块：

1. 工具的一行 `summary` —— 操作未成功时前缀 `FAILED: `；
2. 可选地，一个围栏 `json` 块，内含结构化的 `data` 载荷。

`isError` 与 `ok === false` 一致。注意当**远程命令**以非零码退出时 `remote_exec` 会报告 `ok: false`——非零退出是关于目标的一条有效观测，而不是 MCP 服务器的故障。

### 请求是串行的

进入的消息一次只处理一条（`chain = chain.then(...)`）。否则针对同一目标的并发工具调用会让输出交错，日志也就无法对应。某个 handler 抛异常会被捕获并记日志；会话照常存活。

### stdin 卫生

单行上限 8 MiB。如果客户端持续流入超过该上限、却始终没有换行的字节，服务器会丢弃这一段，并在下一个换行处重新同步，而不是让缓冲区无限增长。一条合法的 JSON-RPC 消息离这个尺寸差得远。

---

## 七个工具

名称、参数和闸门都与进程内工具完全一致——参数表见 [commands.md](commands.md)。

| 工具 | 操作 |
| --- | --- |
| `remote_status` | 总览；`refresh: true` 会先重新探测 |
| `remote_exec` | 一条 shell 命令行，返回 stdout/stderr/退出码 |
| `remote_files` | `list` · `read` · `upload` · `download` |
| `remote_docker` | `ps` · `logs` · `start` · `stop` · `restart` · `pause` · `unpause` |
| `remote_services` | `status` · `start` · `stop` · `restart` · `reload` |
| `remote_processes` | `list` · `kill`（需要 `confirm: true`） |
| `remote_panel` | `open` · `status` |

### MCP 里的 `remote_panel`：只有 status

MCP 进程没有窗口启动器——它是一个无头子进程，没有接上 `launchPanel` 助手。所以：

- `action: "open"` 会失败，报
  `no panel launcher is available in this context (the MCP server only reports the state file; use action: "status")`。
- `action: "status"` 可用，报告状态文件路径、解析出的可执行文件路径（在这里永远是
  `null`）以及目标总数。

要真正打开窗口，请用 `/wsx panel` 命令或 DSH 侧的 `remote_panel` 工具。窗口本身是 **Windows-only**（WinUI 3）。

### 同一套闸门，同一种拒绝

`allowMutations: false` 会拒绝 docker/service 操作和上传，消息与 DSH 侧产生的那条一样、带有同样的解释。`kill` 依然需要它自己的 `confirm: true`，PID 1 依然被硬拒绝。`remote_exec` 有意**不**受 `allowMutations` 覆盖——插件无法判断一条任意命令是不是只读的，这个判断属于调用方。

---

## 独立检查（不需要 DSH）

这是证明服务器可用最快的方式，完全不碰 DSH profile。让它读一份内联配置，再喂给它一行 JSON-RPC：

```powershell
$env:DSH_WSX_CONFIG = '{"config":{"targets":[{"kind":"wsl","distro":"Ubuntu-24.04","channel":"wsl","user":"root"}]}}'
'{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | node .\bin\mcp-server.js
```

在 `C:\path\to\dsh-remote-panel` 的一份检出里运行它。你应该看到：

- **stdout** —— 恰好一行：包含全部七个工具定义的 JSON-RPC 回复。
- **stderr** —— `config source: DSH_WSX_CONFIG`、状态文件、目标 id，然后是 `ready` 和
  `initial probe complete`。

换成其他方法来练更多协议面：

```powershell
'{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05"}}' | node .\bin\mcp-server.js
'{"jsonrpc":"2.0","id":2,"method":"ping"}'                                                 | node .\bin\mcp-server.js
'{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"remote_status","arguments":{}}}' | node .\bin\mcp-server.js
'{"jsonrpc":"2.0","id":4,"method":"nope"}'                                                 | node .\bin\mcp-server.js
```

因为 stdin 关闭时服务器就退出，一个简单的管道就能给你一次干净的一次性请求。
注意初始探测是在后台跑的，所以同一条一次性管道里紧接着的 `remote_status` 对慢目标可能仍报告 `unknown`——这是一次性形式的时序假象，不是探测失败。

---

## 排障

| 症状 | 可能原因 | 怎么办 |
| --- | --- | --- |
| 客户端里始终不出现 MCP 工具 | `args` 路径没有解析到 `bin/mcp-server.js` | patch 是用 `%DSH_PROFILE_DIR%` 拼出来的；用 `dsh --profile <name> --dump-config` 看它到底解析成了什么 |
| 服务器启动了，但目标列表是空的 | host 插件从未运行过，因此 `config.resolved.json` 不存在 | 启动一次 DSH，让 host 写入 resolved config（或设置 `DSH_WSX_CONFIG`） |
| MCP 看到的目标列表是旧的 | 读到了过期的 `config.resolved.json` | 重启 MCP 客户端；host 每次启动都会重写该文件 |
| 一次调用之后会话立刻死掉 | 有东西写到了 stdout | 在服务器导入的任何东西里 grep 游离的 `console.log` / `process.stdout.write`；只有 `send()` 可以碰 stdout |
| `Method not found: ...` | 客户端用了本服务器未实现的能力（resources、prompts、订阅） | 属预期——只有 `initialize`、`ping`、`tools/list` 和 `tools/call` 真正干活 |
| `Parse error: ...` | 客户端发了一条格式错误或美化打印过的 JSON 消息 | MCP stdio 消息必须**每行一条** |
| 调用失败并带 `allowMutations` 消息 | 插件配置是只读的 | 在 `dsh-remote-panel` 那一行设 `allowMutations: true`，或接受只读路径可用这一事实 |

---

[↑ 回到中文](#mcp-服务器)

<a id="english"></a>

# MCP server (English)

How to reach the same remote/WSL targets from any MCP client, through the bundled zero-dependency
stdio server at `bin/mcp-server.js`.

The server is not a second implementation. It imports the exact same `TOOL_SPECS` and the exact
same operation layer (`lib/remote-ops.js`) that the in-process `remote_*` agent tools use, so
argument validation, name resolution and every safety gate behave identically on both sides.

---

## What it is

| | |
| --- | --- |
| Entry point | `bin/mcp-server.js` (also exposed as the `dsh-remote-panel-mcp` bin) |
| Transport | stdio, newline-delimited JSON-RPC 2.0 (one message per line) |
| Dependencies | none — Node built-ins only, no build step |
| Requires | Node.js 20 or newer |
| Server name in DSH | `remote_panel` → tools appear as `mcp__remote_panel__<toolname>` |
| Writes state? | **No.** The MCP process only reads the state file (`writeState: false`) so it can never race the host plugin's heartbeat. |
| stdout | Protocol JSON **only** |
| stderr | All diagnostics (`[dsh-remote-panel mcp] ...`) |

> The one rule that matters if you ever edit this file: **never write anything but protocol JSON
> to stdout.** A single stray character breaks the session. Log to stderr.

### Why it exists

DSH vendors `@modelcontextprotocol/client` and `.../core` but no server package, and this plugin
deliberately stays dependency-free. MCP's stdio transport is simple enough — one JSON-RPC message
per line — that implementing it directly is more controllable than pulling in an SDK.

---

## Registering it

`cordis.patch.yml` already contains an insert that mounts DSH's own MCP client against this server:

```yaml
- id: mcp-remote-panel
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: remote_panel
    transport: stdio
    command: !!js process.execPath
    args: !!js "process.env.DSH_PROFILE_DIR ? [process.env.DSH_PROFILE_DIR + '/node_modules/dsh-remote-panel/bin/mcp-server.js'] : []"
    cwd: !!js "process.env.DSH_PROFILE_DIR || process.cwd()"
    failOnStartupError: false
    toolCallTimeoutMs: 120000
```

Worth knowing:

- The path is assembled from `process.execPath` and `%DSH_PROFILE_DIR%` instead of a hard-coded
  absolute path, so a `link:` install and a copied install both work and no home-directory path
  ends up inside the published package.
- `failOnStartupError: false` — an unreachable target must not take DSH's startup down. Probe
  failures are reported normally by the tools.
- `toolCallTimeoutMs: 120000` — deliberately generous, because a cold WSL distribution can burn
  18–88 s inside a single call.
- **Delete the whole block if you do not want MCP.** `/wsx`, the `remote_*` tools and the panel
  are unaffected.

Restart DSH after editing the patch. The server is a child process, so a change to
`bin/mcp-server.js` also needs a restart (the old child keeps running otherwise).

To use the server from a *different* MCP client, launch it yourself and speak JSONL over its
stdin/stdout. No arguments are needed.

---

## Config discovery

Targets come from the **host plugin's resolved config**, not from a second copy. The server tries,
in order:

| # | Source | Notes |
| --- | --- | --- |
| 1 | `DSH_WSX_CONFIG` | Inline JSON string. Convenient for one-off overrides and tests. |
| 2 | `DSH_WSX_CONFIG_FILE` | Path to a JSON file. |
| 3 | `$DSH_HOME/remote-panel/config.resolved.json` | Written by the host plugin on every start, so MCP and DSH always see the same target list. |

`$DSH_HOME` defaults to `%USERPROFILE%\.dsh` when the environment variable is not set.

The file at step 3 wraps the payload as `{ generatedAt, stateFile, config }`. Sources 1 and 2 may
be either the wrapped form or a bare `{ ... }` config object — the loader accepts both. If nothing
usable is found, the server starts with defaults and logs
`(defaults — no targets configured)` to stderr; `remote_status` then reports zero targets rather
than failing.

At startup the server logs its config source, the state file, the resolved target ids and any
config problems to stderr, then kicks off an initial probe **asynchronously** — the protocol
handshake is never blocked by a slow target.

---

## Protocol surface

| Method | Behaviour |
| --- | --- |
| `initialize` | Returns `protocolVersion`, `capabilities.tools.listChanged: false`, `serverInfo` and a short `instructions` string. If the client asks for a version this server knows (`2024-11-05`, `2024-10-07`) that version is echoed back; otherwise it answers with its own default, `2024-11-05`. An unsupported request is **never** confirmed. |
| `ping` | Returns `{}`. |
| `tools/list` | Returns the same seven tools as `remote_*`, with standard JSON Schema `inputSchema`. |
| `tools/call` | Runs the tool and returns MCP `content` blocks (see below). |
| `resources/list` | Returns an empty list — this server exposes no resources. |
| `prompts/list` | Returns an empty list. |
| anything else | JSON-RPC error `-32601` `Method not found: <method>`. |
| unparseable line | JSON-RPC error `-32700` `Parse error: ...` with a `null` id (the id is not recoverable). |
| notifications (no `id`) | No reply. `notifications/initialized` is merely logged. |

A `tools/call` for a name that does not exist is **not** a JSON-RPC error: it comes back as a
normal result with `isError: true` and a message listing the available tool names.

### Result shape

Every successful call returns one or two text blocks:

1. the tool's one-line `summary` — prefixed with `FAILED: ` when the operation did not succeed;
2. optionally, a fenced `json` block with the structured `data` payload.

`isError` mirrors `ok === false`. Note that `remote_exec` reports `ok: false` when the **remote
command** exited non-zero — a non-zero exit is a valid observation about the target, not a failure
of the MCP server.

### Requests are serialised

Incoming messages are processed one at a time (`chain = chain.then(...)`). Concurrent tool calls
against the same target would otherwise interleave output and make logs impossible to correlate.
A handler that throws is caught and logged; the session survives.

### stdin hygiene

A single line is capped at 8 MiB. If a client streams bytes with no newline past that cap, the
server drops the segment and resynchronises at the next newline instead of growing its buffer
without bound. A valid JSON-RPC message is never anywhere near that size.

---

## The seven tools

Identical names, parameters and gates to the in-process tools — see
[commands.md](commands.md) for the parameter tables.

| Tool | Operations |
| --- | --- |
| `remote_status` | overview; `refresh: true` re-probes first |
| `remote_exec` | one shell command line, stdout/stderr/exit code |
| `remote_files` | `list` · `read` · `upload` · `download` |
| `remote_docker` | `ps` · `logs` · `start` · `stop` · `restart` · `pause` · `unpause` |
| `remote_services` | `status` · `start` · `stop` · `restart` · `reload` |
| `remote_processes` | `list` · `kill` (needs `confirm: true`) |
| `remote_panel` | `open` · `status` |

### `remote_panel` over MCP: status only

The MCP process has no window launcher — it is a headless child process with no `launchPanel`
helper wired in. So:

- `action: "open"` fails with
  `no panel launcher is available in this context (the MCP server only reports the state file; use action: "status")`.
- `action: "status"` works and reports the state-file path, the resolved executable path (always
  `null` here) and the target totals.

Use the `/wsx panel` command or the DSH-side `remote_panel` tool to actually open the window. The
window itself is **Windows-only** (WinUI 3).

### Same gates, same refusals

`allowMutations: false` refuses docker/service actions and uploads with the same explanatory
message the DSH side produces. `kill` still requires its own `confirm: true` and PID 1 is still
hard-refused. `remote_exec` is intentionally **not** covered by `allowMutations` — the plugin
cannot tell whether an arbitrary command is read-only, so that judgement belongs to the caller.

---

## Standalone check (no DSH required)

This is the fastest way to prove the server works without touching a DSH profile. Point it at an
inline config and feed it one JSON-RPC line:

```powershell
$env:DSH_WSX_CONFIG = '{"config":{"targets":[{"kind":"wsl","distro":"Ubuntu-24.04","channel":"wsl","user":"root"}]}}'
'{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | node .\bin\mcp-server.js
```

Run it from a checkout of `C:\path\to\dsh-remote-panel`. What you should see:

- **stdout** — exactly one line: the JSON-RPC reply containing all seven tool definitions.
- **stderr** — `config source: DSH_WSX_CONFIG`, the state file, the target ids, then `ready` and
  `initial probe complete`.

Swap in other methods to exercise more of the surface:

```powershell
'{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05"}}' | node .\bin\mcp-server.js
'{"jsonrpc":"2.0","id":2,"method":"ping"}'                                                 | node .\bin\mcp-server.js
'{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"remote_status","arguments":{}}}' | node .\bin\mcp-server.js
'{"jsonrpc":"2.0","id":4,"method":"nope"}'                                                 | node .\bin\mcp-server.js
```

Because the server exits when stdin closes, a simple pipe gives you a clean one-shot request.
Note that the initial probe runs in the background, so an immediate `remote_status` in the same
one-shot pipe may still report `unknown` for a slow target — that is a timing artefact of the
one-shot form, not a probe failure.

---

## Troubleshooting

| Symptom | Likely cause | What to do |
| --- | --- | --- |
| MCP tools never appear in the client | The `args` path does not resolve to `bin/mcp-server.js` | The patch builds it from `%DSH_PROFILE_DIR%`; inspect what it resolved to with `dsh --profile <name> --dump-config` |
| Server starts, but the target list is empty | The host plugin has never run, so `config.resolved.json` does not exist | Start DSH once so the host writes the resolved config (or set `DSH_WSX_CONFIG`) |
| MCP sees a stale target list | An old `config.resolved.json` was read | Restart the MCP client; the host rewrites the file on every start |
| The session dies right after a call | Something was written to stdout | Grep for stray `console.log` / `process.stdout.write` in anything the server imports; only `send()` may touch stdout |
| `Method not found: ...` | The client used a capability this server does not implement (resources, prompts, subscriptions) | Expected — only `initialize`, `ping`, `tools/list` and `tools/call` do real work |
| `Parse error: ...` | The client sent a malformed or pretty-printed JSON message | MCP stdio messages must be **one line each** |
| A call fails with an `allowMutations` message | The plugin config is read-only | Set `allowMutations: true` on the `dsh-remote-panel` row, or accept that only read paths are available |
