# 命令与 agent 工具

<!-- 中文 | English -->
**中文** ｜ [English](#english)

人敲的 `/wsx` 会话命令，和模型调用的七个 `remote_*` 工具 —— 同一套底层操作，两种形态。

只要插件被加载，下面这些就都可用。两个界面在 README 里都有概要层面的描述；本文档是参数级参考。

| | `/wsx ...` | `remote_*` 工具 |
| --- | --- | --- |
| 调用方 | 人，不经过模型 | 模型 |
| 输出 | 对齐的纯文本表格 | `{ ok, summary, data }` —— 一行给人看的结论，加结构化 JSON |
| 与谁同一份实现 | 这些工具 | MCP 服务器 |
| 注册方式 | `ctx.commands.register({ name: 'wsx' })` | `ctx.tools.register(...)`，每个工具一条 |

---

## `/wsx`

### 参数处理

`/wsx` 拿到的是 `invocation.rawInput` —— `/wsx` **之后**的文本，原样传入，包括任何前导空白。DSH 不做
trim，插件自己做，然后按空白切分。第一个 token 是子命令（大小写不敏感），其后的一切都是该子命令的参数。

有两个后果值得记住：

- 目标选择器可以含空格（`/wsx status WSL Ubuntu 24.04`）—— 剩下的 token 会被重新拼成一个选择器字符串。
- `/wsx exec` 故意用正则重新解析原始字符串，而不用 token 列表，因为命令内容不能被切分。
  `/wsx exec\t<target> <cmd>`（用制表符代替空格）也能用，这对脚本化和由 agent 生成的输入很重要。

每个子命令的失败都汇入同一种形态：`kind: 'error'` 加一条非空消息。DSH 要求错误文本非空，所以不存在静默失败这种模式。

### 子命令

| 命令 | 做什么 |
| --- | --- |
| `/wsx` | 无参数 —— 等同于 `status`。 |
| `/wsx status [target]` | 总览：总数、每个目标一行，然后每个探测失败的目标一个区块。带选择器时是同一套渲染、收窄到那一个目标，并用它的名字作标题。 |
| `/wsx list` | 列的是**配置**而不是状态：id、name、kind、distro/host:port，以及该目标走哪条通道。另外追加一行摘要（探测间隔、超时、并发数、写操作是否启用）和工具注册路径。 |
| `/wsx probe [target]` | 立即探测并等待。不带选择器就探测全部并报告失败个数；带选择器则内联报告该目标的结果和错误。 |
| `/wsx docker [target]` | 容器列表，包含已停止的（最多 60 个）。 |
| `/wsx services [target]` | 关键服务状态（systemd，退化时用 sysvinit），目标配置了 `services` 列表时就用它。 |
| `/wsx ps [target] [n]` | 按 CPU 排序的顶部进程（默认 12）。 |
| `/wsx exec <target> <command>` | 在目标上跑一条命令行，显示退出码、耗时、所用通道和合并后的输出。 |
| `/wsx panel` | 显示或置前 WinUI 3 预览窗口。 |
| `/wsx open` | 在系统文件浏览器里打开插件的数据目录（`$DSH_HOME/remote-panel`）。 |
| `/wsx help` | 打印用法块。 |

未知子命令返回的错误里带着完整用法块，所以打错字可以自我纠正。

### 目标选择

选择器可以是 `id`、`name`、主机名，或其中任何一项的**唯一片段**。

| 情况 | 行为 |
| --- | --- |
| 省略选择器，且恰好配置了**一个**目标 | 就用那个目标 —— 单目标安装上 `/wsx docker` 直接可用。 |
| 省略选择器，且存在多个目标 | 拒绝，并列出已配置的 id：`请指定目标。已配置：...` |
| 省略选择器，且**没有**配置任何目标 | 拒绝，并给出配置提示（在 `dsh-remote-panel` 那一行里加 `targets`）。 |
| 选择器匹配到**不止一个**目标 | 拒绝，列出候选并要求你更精确。插件绝不会替你挑一个。 |
| 选择器匹配不到任何目标 | 拒绝，并列出已配置的目标。 |

"歧义一律拒绝"这条规则与 `remote_*` 工具共用 —— 两者调用同一个 `requireTargetSelector`，所以同一个
选择器字符串绝不会因为你用的是哪个界面而指向两台不同的机器。

### 各子命令备注

**`docker`** —— 三种截然不同的结果，全部按普通文本报告而不是错误：

| 输出 | 含义 |
| --- | --- |
| `<target> 上没有 docker CLI。` | 目标上没有 `docker` 可执行文件（`docker.available: false`）。 |
| `<target> 上的 docker 不可用：<message>` | Docker 存在但命令失败了 —— 通常是权限问题。这条消息是 **docker 自己的**错误文本，不是转述。 |
| `<target> 上没有容器。` | Docker 正常，只是压根没有容器。 |

**`services`** —— 报告用了哪个 runner（`systemd` / `sysvinit`）以及检查了多少个服务。什么都没找到时它会
说明这一点并点名 runner，这就是"目标两者都没有"的线索。

**`ps`** —— `/wsx ps <target> <n>` 和 `/wsx ps <n> <target>` 都接受：插件挑出第一个纯数字 token 当作数量，
其余当作选择器。

**`exec`** —— 输出块先是 `stdout`，再是 `stderr`，然后是 `result.error`，**仅当没有 stderr 时**。最后这条
对超时很重要：超时时 stderr 为空，所以原因（`timed out after Ns, cold WSL start...`）否则就会藏在一个光秃秃的
`退出码 —` 后面。头部行始终显示原因（`超时（<ms>ms）` 或 `退出码 <n>`）、耗时，以及实际用到的通道。

**`panel`** —— 找不到 `WsxPanel.exe` 时以一条可操作的错误失败，告诉你运行 `build.ps1 -Pack` 或设置
`appPath`。该窗口是 **Windows 专属**（WinUI 3 需要 Windows 10 1809+）；在其他系统上插件能加载、命令和工具能用，
但永远不会有浮动窗口出现。网页面板不受影响。

**`open`** —— 在 Windows 上用 `explorer.exe`，macOS 上用 `open`，其他平台用 `xdg-open`。它启动进程后立即
返回，附带解析出的目录路径。

### `list` 还会报告工具注册路径

`/wsx list` 末尾会有一行，形如 `工具注册路径：raw (defineTool unavailable: ...)`。它告诉你工具是走了官方的
`defineTool` 辅助函数（额外的 schema 规范化与校验），还是退回到注册一份裸 JSON Schema。

看到 `raw` **不是**故障。`@deepseek-ai/*` 这些包只存在于 `app.asar` 内部，所以第三方插件对它们的 ESM import
可能无法解析；回退路径的存在正是为了让工具两种情况都能用。行为、参数校验和每一道安全闸门在两条路径上完全一致。
只有当某个工具在工具列表里彻底不见时，注册才值得排查。

---

## Agent 工具

七个工具，与 MCP 服务器共享一份实现和一套闸门。

通用约定：

- `target` 接受 id、name、主机名，或唯一片段。先调 `remote_status` 了解可用的 id。有歧义的片段会被拒绝，并列出候选。
- 每个结果都是 `{ ok, summary, data }` —— `ok` 表示这次*操作*是否成功，`summary` 是一行人类可读的结论，
  `data` 是结构化载荷。实现不抛异常；失败也是一种正常结果。
- `data` 始终是无损 JSON（没有 `undefined`，没有 `NaN`/`Infinity`），因为 DSH 的工具结果校验会拒绝非无损值，
  而它给出的错误并不会点出是哪个字段有问题。

### `remote_status`

所有已配置目标（或其中一个）的总览。

| 参数 | 类型 | 必需 | 备注 |
| --- | --- | --- | --- |
| `target` | string | 否 | 把报告限制到一个目标。 |
| `refresh` | boolean | 否 | 立即探测，而不是报告缓存数据。与 `target` 同用时只探测那一个；不带时重新探测全部。 |

`data` 携带 `totals`、`generatedAt`、一个 `ageText`（"12s ago"）、带各自指标的每目标数组、失败目标列表，
以及任何配置错误。每条在线行概括了 cpu、mem、最差磁盘、docker 运行数和延迟。

`refresh: true` 会**等待**探测，所以你拿到的数字是当下的；不带它你拿到的是快照里的最后一次采样。`latencyMs`
是那一轮的链路开销。

### `remote_exec`

一条命令行，经由目标上的 POSIX shell 执行。

| 参数 | 类型 | 必需 | 备注 |
| --- | --- | --- | --- |
| `target` | string | **是** | |
| `command` | string | **是** | 作为单个字符串传入；由目标的 shell 解析。 |
| `timeoutMs` | integer | 否 | 被夹到 **3000–600000**。默认取该目标的有效超时（设了 `targets[].timeoutMs` 就用它，否则用全局值）。 |
| `maxBytes` | integer | 否 | 被夹到 **1024–4194304**；默认 **65536**。分别作用于 stdout 和 stderr，并带一个 `… [truncated N bytes]` 标记。 |

`data` 报告 `target`、`channel`、`exitCode`、`timedOut`、`durationMs`、`stdout`、`stderr` 和 `error`。

有两个行为需要提前考虑：

- **`ok` 反映的是远端命令的退出码，而不是链路。** 非零退出码是一条有效观察，会以 `ok: false` 连同退出码和
  输出一起报告。超时与非零退出不同，由 `timedOut` 加一个 `error` 字符串标记 —— 失败原因之所以放在 `error`
  里，正是因为超时时 stderr 为空。
- **这个工具不受 `allowMutations` 把关。** 它可以被喂任何命令，所以插件无从判断它是否只读。保持只读是调用方
  的责任。能用 `remote_docker` / `remote_services` / `remote_processes` / `remote_files` 的地方优先用它们
  —— 它们会校验参数并安全引用。

不要试图在本地展开 `$(...)` 或反引号；它们会在字符串到达目标之前就被本地 shell 求值。把引号写在命令字符串内部。

### `remote_files`

| 参数 | 类型 | 必需 | 备注 |
| --- | --- | --- | --- |
| `target` | string | **是** | |
| `operation` | string | **是** | `list` · `read` · `upload` · `download` |
| `remotePath` | string | **每个操作都必需** | 必须是**绝对 POSIX 路径**（以 `/` 开头）。相对路径会被拒绝，而不是被猜测 —— 落地目录在不同登录 shell 之间不一样。 |
| `localPath` | string | `upload` 和 `download` 必需 | |
| `makeDirs` | boolean | 否 | 仅 `upload`：创建远端父目录。 |
| `mode` | string | 否 | 仅 `upload`：八进制 chmod，例如 `"0644"`。 |
| `overwrite` | boolean | 否 | 仅 `download`：覆盖已存在的本地文件。 |
| `maxBytes` | integer | 否 | 仅 `read`：默认 **262144**，夹到 1–4194304。 |

| 操作 | 返回 |
| --- | --- |
| `list` | `path`、`entries`，列表触及上限时有 `truncated`。 |
| `read` | `path`、`content`、`totalBytes`、`truncated`。非普通文件是显式错误，而不是空读取。 |
| `upload` | `bytes`、`remotePath`、`via`、`durationMs`，以及一个 `warnings` 数组。 |
| `download` | `bytes`、`remotePath`、`localPath`、`via`。 |

**传输机制。** 先用 `scp`；如果目标没有 sftp-server，插件退回到 over SSH 的 base64。`via` 字段说明用了哪
一种。回退上限是 **8 MB** —— 更大的文件直接被拒绝，而不是冒着静默截断的风险。要搬大文件就在目标上装好可用的
`scp`/sftp-server。

**上传是写操作**，`allowMutations: false` 时会被拒绝。远端写入走"写临时文件 → 校验字节数 → `mv -f`"三步，
所以传输失败不会截断已存在的文件。上传成功但某个次要环节没成功时（比如 `chmod` 被拒）会出现 `warnings`
—— 读它，否则你会以为权限已经应用上了。

### `remote_docker`

| 参数 | 类型 | 必需 | 备注 |
| --- | --- | --- | --- |
| `target` | string | **是** | |
| `operation` | string | **是** | `ps` · `logs` · `start` · `stop` · `restart` · `pause` · `unpause` |
| `container` | string | 除 `ps` 外都必需 | 容器名或 id。 |
| `all` | boolean | 否 | 仅 `ps`：包含已停止容器。默认 **true**。 |
| `lines` | integer | 否 | 仅 `logs`：末尾行数，默认 **100**。 |
| `since` | string | 否 | 仅 `logs`：docker 自己的 `--since` 值，例如 `"30m"`、`"1h"`。 |
| `timeoutSec` | integer | 否 | 仅 `stop` / `restart`：优雅停止超时，单位秒。 |

容器名会对照字符白名单校验（字母、数字、`. _ - : @`）。含空格或 shell 元字符的名字会被**拒绝**，而不是转义
后放行 —— 这种名字本来也不可能是真容器名。

`ps` 明确区分三种情况：没有 docker CLI；docker 在但失败（返回 docker 自己的错误文本，通常是
"permission denied"，因为用户不在 `docker` 组里 —— 这是权限问题，不是插件故障）；以及单纯的零容器。

`logs` 输出被截断时会带 `truncated: true` 标记。`start`/`stop`/`restart`/`pause`/`unpause` 是写操作，
`allowMutations: false` 时会被拒绝。

### `remote_services`

| 参数 | 类型 | 必需 | 备注 |
| --- | --- | --- | --- |
| `target` | string | **是** | |
| `operation` | string | **是** | `status` · `start` · `stop` · `restart` · `reload` |
| `services` | string[] | 否 | 仅 `status`：要检查哪些服务。默认取目标配置的 `services` 列表，再退到 `ssh`/`sshd`/`docker`/`cron`/`nginx`。 |
| `service` | string | 写操作必需 | |

`status` 报告 runner（`systemd` 或 `sysvinit`）、数量，以及每个服务的 `active`/`sub`。
`start`/`stop`/`restart`/`reload` 是写操作，`allowMutations: false` 时会被拒绝。启停通常需要 root，
权限失败就如实报告为权限失败 —— 错误会解释这是权限问题，而不是把它包装成插件故障。

### `remote_processes`

| 参数 | 类型 | 必需 | 备注 |
| --- | --- | --- | --- |
| `target` | string | **是** | |
| `operation` | string | **是** | `list` · `kill` |
| `sort` | string | 否 | 仅 `list`：`cpu`（默认）或 `mem`。 |
| `limit` | integer | 否 | 仅 `list`：多少行，默认 **15**。 |
| `filter` | string | 否 | 仅 `list`：对命令行做大小写不敏感的子串匹配。 |
| `pid` | integer | **仅 `kill`** | |
| `signal` | string | 否 | 仅 `kill`：不带 `SIG` 前缀的名字，例如 `TERM`（默认）或 `KILL`。 |
| `confirm` | boolean | **仅 `kill`** | 必须为 `true`。 |

**`kill` 有自己的闸门，独立于 `allowMutations`。** 按 PID 杀进程是唯一一个参数写错就能把目标搞挂的操作，
所以它不共用通用的写开关：

- 没有 `confirm: true` 就被拒绝，错误为
  `kill_process requires "confirm": true. ...` —— 即使 `allowMutations` 是 `true`。
- **PID 1 被硬拒绝**（`refusing to signal PID 1 — that would take the whole target down`）。
- 结果会回显插件从目标 `ps` 读到的进程身份，这样你能核对 PID 确实是你想发信号的那个。如果身份与你预期不符，
  不要继续。

安全顺序永远是：先 `list`（可选带 `filter`），再对确认过的 PID 执行 `kill`。

### `remote_panel`

| 参数 | 类型 | 必需 | 备注 |
| --- | --- | --- | --- |
| `action` | string | **是** | `open` · `status` |

- `open` 启动或抬起置顶的 WinUI 3 窗口，它渲染的快照与 `remote_status` 相同。`ok` 反映窗口是否真的起来了；
  没起来时消息会解释原因（找不到可执行文件，或 `autoLaunch: false`）。
- `status` 报告状态文件路径、可执行文件路径和目标总数，不启动任何东西。

`action` 会被显式校验：无法识别的值是一个错误，而不是静默地当成 `status`。这很重要，因为裸 JSON Schema
注册路径并不保证 `enum` 会被强制，而为一个错别字悄悄返回 `status` 会让调用方以为窗口开了。

**Windows 专属。** 该窗口是 WinUI 3 程序。在其他宿主上工具存在、`status` 可用，但没有窗口可开。这个工具的
MCP 版本完全没有启动器 —— 见 [mcp.md](mcp.md)。

---

## 安全闸门

| 闸门 | 范围 | 行为 |
| --- | --- | --- |
| `allowMutations: false` | docker start/stop/restart/pause/unpause、service start/stop/restart/reload、文件**上传** | 拒绝，消息点名配置行以及如何重新启用。 |
| `confirm: true` | 仅 `remote_processes` 的 `kill` | 独立于 `allowMutations`。缺了它永远是拒绝。 |
| PID 1 保护 | `remote_processes` 的 `kill` | 无条件硬拒绝。 |
| 名称白名单 | 容器名、服务名 | 只允许 `[A-Za-z0-9._:@-]`；其他字符会被拒绝，而不是转义后放行。 |
| 路径校验 | `remote_files` | 远端路径必须是绝对 POSIX 路径；NUL 字节会被拒绝。 |
| 参数引用 | 一切到达远端 shell 的东西 | 每个动态片段都过 `shq()` 单引号转义（`'` → `'\''`）。单元测试验证 `;`、`&&`、`\|`、`$(...)`、反引号、重定向、换行和引号全都保持字面量。 |
| **无闸门** | `remote_exec` / `/wsx exec` | 故意在 `allowMutations` 之外，因为插件无法判断任意命令是否只读。**这个判断归调用方。** |

插件也不会针对同一个目标串行化写操作：两个调用同时重启同一个容器不会被阻止。

---

## 预期中的失败模式

| 症状 | 解释 |
| --- | --- |
| WSL 目标首次探测耗时 18–88 秒，之后不到一秒 | **冷启动，不是故障。** WSL 在最后一个 `wsl.exe` 会话结束后大约一分钟拆掉发行版。要么接受它（全局 `timeoutMs` 默认 60000 已经覆盖），要么在 `%USERPROFILE%\.wslconfig` 里设 `vmIdleTimeout=3600000`（代价是约 1.4 GB 常驻内存）。超过 10 秒的探测在面板里会被标注为冷启动。 |
| 交互式 `ssh` 能用，但某个目标永远是 `offline` | SSH 必须基于密钥或 agent。插件始终传 `BatchMode=yes` 和 `NumberOfPasswordPrompts=0`，所以密码提示无法被应答，只支持密码的主机会永远超时。 |
| 指标缺失或不完整 | 探测脚本是 POSIX sh，读取 `/proc`、`df`、`ps`。没有这些工具的目标只能给出它能收集到的部分，`warnings` 会说明数据不完整，而不是假装它完整。 |
| 磁盘列表为空 | 要么 `df` 输出无法解析，要么机器只暴露伪文件系统；tmpfs/overlay/squashfs 之类被有意过滤掉了。 |
| `docker.available: true` 但计数为空 | Docker 装了但 socket 不可读 —— 通常是用户不在 `docker` 组里。返回的是 docker 自己的错误文本。 |
| GPU 字段为空 | 没有 `nvidia-smi`。只支持 NVIDIA。 |
| 下载时报 `cannot read the size of <path>` | base64 回退无法 stat 远端路径 —— 通常是路径写错或权限问题。本地文件保持不动。 |
| WSL 上 `wsl.exe` 报 `Wsl/E_ACCESSDENIED` | 受限的 Windows 沙箱挡住了 `wsl.exe` 需要的命名管道。SSH 进入发行版的 sshd 仍然可用，这也是 `channel: auto` 先试 SSH 的原因。 |
| `service ... usually needs root` | 该账号没有权限。用有权限的账号，或者对 WSL 目标设置 `user: root`（`wsl.exe -u root` 不需要密码）。`sudo` 在这条非交互通道上无法工作 —— 没有 TTY 可以读密码。 |

---

[↑ 回到中文](#命令与-agent-工具)

<a id="english"></a>

# Commands and agent tools (English)

The `/wsx` session commands a human types, and the seven `remote_*` tools a model calls — same
underlying operations, two different shapes.

Everything below is available whenever the plugin is loaded. Both surfaces are described in the
README at a summary level; this document is the parameter-level reference.

| | `/wsx ...` | `remote_*` tools |
| --- | --- | --- |
| Caller | a human, without going through the model | the model |
| Output | aligned plain text tables | `{ ok, summary, data }` — a human line plus structured JSON |
| Same implementation as | the tools | the MCP server |
| Registered as | `ctx.commands.register({ name: 'wsx' })` | `ctx.tools.register(...)`, one entry per tool |

---

## `/wsx`

### Argument handling

`/wsx` receives `invocation.rawInput` — the text **after** `/wsx`, verbatim, including any leading
whitespace. DSH does not trim it; the plugin does, then splits on whitespace. The first token is the
subcommand (case-insensitive) and everything after it is that subcommand's argument.

Two consequences worth remembering:

- A target selector may contain spaces (`/wsx status WSL Ubuntu 24.04`) — the remaining tokens are
  re-joined into one selector string.
- `/wsx exec` deliberately re-parses the raw string with a regex instead of the token list, because
  the command content must not be split. `/wsx exec\t<target> <cmd>` (a tab instead of a space)
  works too, which matters for scripted and agent-generated input.

Every subcommand funnels its failures into one shape: `kind: 'error'` with a non-empty message. DSH
requires error text to be non-empty, so there is no silent failure mode.

### Subcommands

| Command | What it does |
| --- | --- |
| `/wsx` | No argument — same as `status`. |
| `/wsx status [target]` | Overview: totals, one line per target, then a block per failing target. With a selector, the same render restricted to that one target, titled with its name. |
| `/wsx list` | The **configuration**, not the state: id, name, kind, distro/host:port, and which channel the target uses. Adds a summary line (probe interval, timeout, concurrency, whether writes are enabled) and the tool-registration path. |
| `/wsx probe [target]` | Probes now and waits. Without a selector it probes everything and reports how many failed; with one it reports that target's result and error inline. |
| `/wsx docker [target]` | Container listing including stopped ones (up to 60). |
| `/wsx services [target]` | Key service states (systemd, or sysvinit as a fallback) using the target's configured `services` list when it has one. |
| `/wsx ps [target] [n]` | Top processes by CPU (default 12). |
| `/wsx exec <target> <command>` | Runs one command line on the target and shows exit code, duration, channel and combined output. |
| `/wsx panel` | Shows or brings to front the WinUI 3 preview window. |
| `/wsx open` | Opens the plugin's data directory (`$DSH_HOME/remote-panel`) in the OS file browser. |
| `/wsx help` | Prints the usage block. |

An unknown subcommand returns an error containing the full usage block, so a typo is
self-correcting.

### Target selection

A selector may be an `id`, a `name`, a hostname, or a **unique fragment** of any of those.

| Situation | Behaviour |
| --- | --- |
| Selector omitted and exactly **one** target is configured | That target is used — `/wsx docker` on a single-target install just works. |
| Selector omitted and several targets exist | Refused with the list of configured ids: `请指定目标。已配置：...` |
| Selector omitted and **no** targets are configured | Refused with the config hint (add `targets` to the `dsh-remote-panel` row). |
| Selector matches **more than one** target | Refused, listing the candidates, asking you to be more specific. The plugin never picks one for you. |
| Selector matches nothing | Refused with the configured-target list. |

That "ambiguity is always refused" rule is shared with the `remote_*` tools — both call the same
`requireTargetSelector`, so one selector string can never mean two different machines depending on
which surface you used.

### Per-subcommand notes

**`docker`** — three distinct outcomes, all reported as normal text rather than as an error:

| Output | Meaning |
| --- | --- |
| `<target> 上没有 docker CLI。` | No `docker` binary on the target (`docker.available: false`). |
| `<target> 上的 docker 不可用：<message>` | Docker exists but the command failed — usually permissions. The message is **docker's own** error text, not a paraphrase. |
| `<target> 上没有容器。` | Docker is fine, there are simply no containers. |

**`services`** — reports which runner was used (`systemd` / `sysvinit`) and how many services were
checked. If nothing was found it says so and names the runner, which is the clue that the target
has neither.

**`ps`** — `/wsx ps <target> <n>` and `/wsx ps <n> <target>` are both accepted: the plugin pulls out
the first purely numeric token as the count and treats the rest as the selector.

**`exec`** — the output block is `stdout`, then `stderr`, and then `result.error` **only when there
is no stderr**. That last part matters for timeouts: on a timeout stderr is empty, so the reason
("timed out after Ns, cold WSL start...") would otherwise be invisible behind a bare `退出码 —`.
The header line always shows the reason (`超时（<ms>ms）` or `退出码 <n>`), the duration, and the
channel actually used.

**`panel`** — fails with an actionable message when `WsxPanel.exe` cannot be located, telling you
to run `build.ps1 -Pack` or set `appPath`. The window is **Windows-only** (WinUI 3 requires
Windows 10 1809+); elsewhere the plugin loads, the commands and tools work, but no floating window
will ever appear. The web panel is unaffected.

**`open`** — uses `explorer.exe` on Windows, `open` on macOS and `xdg-open` elsewhere. It spawns
and returns immediately with the resolved directory path.

### `list` also reports the tool-registration path

`/wsx list` ends with a line like `工具注册路径：raw (defineTool unavailable: ...)`. It tells you
whether the tools went through the official `defineTool` helper (extra schema normalisation and
validation) or fell back to registering a raw JSON Schema.

Seeing `raw` is **not** a fault. The `@deepseek-ai/*` packages live only inside `app.asar`, so a
third-party plugin's ESM import of them may not resolve; the fallback exists precisely so the tools
work either way. Behaviour, parameter validation and every safety gate are identical on both
paths. Only if a tool is entirely missing from the tool list is registration worth investigating.

---

## Agent tools

Seven tools, sharing one implementation and one set of gates with the MCP server.

Common conventions:

- `target` accepts an id, a name, a hostname, or a unique fragment. Call `remote_status` first to
  learn the available ids. An ambiguous fragment is refused, with candidates listed.
- Every result is `{ ok, summary, data }` — `ok` for whether the *operation* succeeded, `summary`
  as a one-line human-readable result, `data` as the structured payload. Implementations do not
  throw; failure is a normal result.
- `data` is always lossless JSON (no `undefined`, no `NaN`/`Infinity`), because DSH's tool-result
  validation rejects non-lossless values with an error that does not name the offending field.

### `remote_status`

Overview of every configured target, or of one.

| Parameter | Type | Required | Notes |
| --- | --- | --- | --- |
| `target` | string | no | Limit the report to one target. |
| `refresh` | boolean | no | Probe now instead of reporting cached data. With `target` it probes only that one; without, it re-probes everything. |

`data` carries `totals`, `generatedAt`, an `ageText` ("12s ago"), the per-target array with their
metrics, the failing-target list, and any config errors. Each online line summarises cpu, mem,
worst disk, docker running count and latency.

`refresh: true` **waits** for the probe, so the numbers you get are current; without it you get the
last sample in the snapshot. `latencyMs` is that round's link cost.

### `remote_exec`

One command line, run through a POSIX shell on the target.

| Parameter | Type | Required | Notes |
| --- | --- | --- | --- |
| `target` | string | **yes** | |
| `command` | string | **yes** | Passed as a single string; the target's shell parses it. |
| `timeoutMs` | integer | no | Clamped to **3000–600000**. Defaults to the target's effective timeout (`targets[].timeoutMs` if set, otherwise the global one). |
| `maxBytes` | integer | no | Clamped to **1024–4194304**; default **65536**. Applied to stdout and stderr separately, with a `… [truncated N bytes]` marker. |

`data` reports `target`, `channel`, `exitCode`, `timedOut`, `durationMs`, `stdout`, `stderr` and
`error`.

Two behaviours to plan around:

- **`ok` reflects the remote command's exit code, not the link.** A non-zero exit is a valid
  observation, reported as `ok: false` with the exit code and output. A timeout is different from a
  non-zero exit and is flagged by `timedOut` plus an `error` string — the failure reason is carried
  in `error` precisely because stderr is empty on a timeout.
- **This tool is not gated by `allowMutations`.** It can be given any command, so the plugin has no
  way to know whether it is read-only. Keeping it read-only is the caller's responsibility. Prefer
  `remote_docker` / `remote_services` / `remote_processes` / `remote_files` where they fit — they
  validate arguments and quote safely.

Do not try to expand `$(...)` or backticks locally; they would be evaluated by the local shell
before the string ever reaches the target. Put quoting inside the command string.

### `remote_files`

| Parameter | Type | Required | Notes |
| --- | --- | --- | --- |
| `target` | string | **yes** | |
| `operation` | string | **yes** | `list` · `read` · `upload` · `download` |
| `remotePath` | string | **required for every operation** | Must be an **absolute POSIX path** (start with `/`). Relative paths are refused, not guessed — the landing directory differs between login shells. |
| `localPath` | string | required for `upload` and `download` | |
| `makeDirs` | boolean | no | `upload` only: create the remote parent directory. |
| `mode` | string | no | `upload` only: octal chmod, e.g. `"0644"`. |
| `overwrite` | boolean | no | `download` only: replace an existing local file. |
| `maxBytes` | integer | no | `read` only: default **262144**, clamped to 1–4194304. |

| Operation | Returns |
| --- | --- |
| `list` | `path`, `entries`, and `truncated` when the listing hit its cap. |
| `read` | `path`, `content`, `totalBytes`, `truncated`. A non-regular file is an explicit error, not an empty read. |
| `upload` | `bytes`, `remotePath`, `via`, `durationMs`, and a `warnings` array. |
| `download` | `bytes`, `remotePath`, `localPath`, `via`. |

**Transfer mechanism.** `scp` first; if the target has no sftp-server the plugin falls back to
base64 over SSH. The `via` field says which one was used. The fallback is capped at **8 MB** —
larger files are refused outright rather than risking a silently truncated copy. Install a working
`scp`/sftp-server on the target to move big files.

**Uploads are a mutating operation** and are refused when `allowMutations: false`. The remote write
is done as write-temp → verify byte count → `mv -f`, so a failed transfer cannot truncate an
existing file. `warnings` appears when the upload succeeded but something secondary did not (a
rejected `chmod`, for instance) — read it, or you will assume the permissions were applied.

### `remote_docker`

| Parameter | Type | Required | Notes |
| --- | --- | --- | --- |
| `target` | string | **yes** | |
| `operation` | string | **yes** | `ps` · `logs` · `start` · `stop` · `restart` · `pause` · `unpause` |
| `container` | string | required except for `ps` | Container name or id. |
| `all` | boolean | no | `ps` only: include stopped containers. Default **true**. |
| `lines` | integer | no | `logs` only: trailing line count, default **100**. |
| `since` | string | no | `logs` only: docker's own `--since` value, e.g. `"30m"`, `"1h"`. |
| `timeoutSec` | integer | no | `stop` / `restart` only: graceful timeout in seconds. |

Container names are validated against a character whitelist (letters, digits, `. _ - : @`).
A name with a space or a shell metacharacter is **rejected**, not escaped and passed through —
such a name could not be a real container name anyway.

`ps` distinguishes three cases explicitly: no docker CLI, docker present but failing (docker's own
error text is returned, typically "permission denied" because the user is not in the `docker`
group — a permissions problem, not a plugin fault), and simply zero containers.

`logs` output is truncated with a `truncated: true` flag. `start`/`stop`/`restart`/`pause`/
`unpause` are mutating operations and are refused when `allowMutations: false`.

### `remote_services`

| Parameter | Type | Required | Notes |
| --- | --- | --- | --- |
| `target` | string | **yes** | |
| `operation` | string | **yes** | `status` · `start` · `stop` · `restart` · `reload` |
| `services` | string[] | no | `status` only: which services to check. Defaults to the target's configured `services` list, then to `ssh`/`sshd`/`docker`/`cron`/`nginx`. |
| `service` | string | required for the mutating operations | |

`status` reports the runner (`systemd` or `sysvinit`), the count, and per-service `active`/`sub`.
`start`/`stop`/`restart`/`reload` are mutating operations and are refused when
`allowMutations: false`. Starting and stopping usually needs root, and a permission failure is
reported as exactly that — the error explains the privilege problem instead of presenting it as a
plugin malfunction.

### `remote_processes`

| Parameter | Type | Required | Notes |
| --- | --- | --- | --- |
| `target` | string | **yes** | |
| `operation` | string | **yes** | `list` · `kill` |
| `sort` | string | no | `list` only: `cpu` (default) or `mem`. |
| `limit` | integer | no | `list` only: how many rows, default **15**. |
| `filter` | string | no | `list` only: case-insensitive substring match on the command line. |
| `pid` | integer | **`kill` only** | |
| `signal` | string | no | `kill` only: name without the `SIG` prefix, e.g. `TERM` (default) or `KILL`. |
| `confirm` | boolean | **`kill` only** | Must be `true`. |

**`kill` has its own gate, separate from `allowMutations`.** Killing by PID is the one operation
where a wrong argument can take down the target, so it does not share the general mutation switch:

- Without `confirm: true` it is refused with
  `kill_process requires "confirm": true. ...` — even when `allowMutations` is `true`.
- **PID 1 is hard-refused** (`refusing to signal PID 1 — that would take the whole target down`).
- The result echoes the process identity the plugin read from the target's `ps`, so you can check
  that the PID really is what you meant to signal. If the identity does not match what you expected,
  do not proceed.

The safe order is always `list` first (optionally with `filter`), then `kill` on the confirmed PID.

### `remote_panel`

| Parameter | Type | Required | Notes |
| --- | --- | --- | --- |
| `action` | string | **yes** | `open` · `status` |

- `open` launches or raises the always-on-top WinUI 3 window, which renders the same snapshot as
  `remote_status`. `ok` tracks whether the window actually came up; the message explains the
  failure when it did not (executable not found, or `autoLaunch: false`).
- `status` reports the state-file path, the executable path and the target totals without
  launching anything.

`action` is validated explicitly: an unrecognised value is an error rather than a silent `status`.
That matters because the raw-JSON-Schema registration path does not guarantee an `enum` is
enforced, and quietly returning `status` for a typo would let a caller believe a window opened.

**Windows-only.** The window is a WinUI 3 program. On other hosts the tool exists and `status`
works, but there is no window to open. The MCP variant of this tool has no launcher at all — see
[mcp.md](mcp.md).

---

## Safety gates

| Gate | Scope | Behaviour |
| --- | --- | --- |
| `allowMutations: false` | docker start/stop/restart/pause/unpause, service start/stop/restart/reload, file **upload** | Refused, with a message naming the config row and how to re-enable it. |
| `confirm: true` | `remote_processes` `kill` only | Independent of `allowMutations`. Missing it is always a refusal. |
| PID 1 protection | `remote_processes` `kill` | Hard-refused, unconditionally. |
| Name whitelist | container names, service names | `[A-Za-z0-9._:@-]` only; anything else is rejected rather than escaped and passed through. |
| Path validation | `remote_files` | Remote paths must be absolute POSIX paths; NUL bytes are rejected. |
| Argument quoting | everything that reaches the remote shell | Every dynamic fragment goes through `shq()` single-quote escaping (`'` → `'\''`). Unit tests verify that `;`, `&&`, `\|`, `$(...)`, backticks, redirections, newlines and quotes all stay literal. |
| **No gate** | `remote_exec` / `/wsx exec` | Deliberately outside `allowMutations`, because the plugin cannot judge whether an arbitrary command is read-only. **The caller owns that judgement.** |

The plugin also does not serialise writes against a target: two calls restarting the same container
at the same time are not prevented.

---

## Failure modes to expect

| Symptom | Explanation |
| --- | --- |
| First probe of a WSL target takes 18–88 s, later ones under a second | **Cold start, not a fault.** WSL tears the distribution down roughly a minute after the last `wsl.exe` session. Either accept it (the global `timeoutMs` default of 60000 already covers it) or set `vmIdleTimeout=3600000` in `%USERPROFILE%\.wslconfig` (at the cost of ~1.4 GB resident). A probe over 10 s is badged as a cold start in the panel. |
| A target is always `offline` although `ssh` works interactively | SSH must be key- or agent-based. The plugin always passes `BatchMode=yes` and `NumberOfPasswordPrompts=0`, so a password prompt cannot be answered and a password-only host simply times out forever. |
| Metrics are missing or partial | The probe script is POSIX sh and reads `/proc`, `df`, `ps`. A target without that tooling yields whatever it could collect, and `warnings` says the data is incomplete rather than pretending it is whole. |
| Disk list empty | Either `df` output was unparseable or the machine only exposes pseudo-filesystems; tmpfs/overlay/squashfs and friends are filtered out on purpose. |
| `docker.available: true` but counts empty | Docker is installed but the socket is unreadable — usually the user is not in the `docker` group. Docker's own error text is returned. |
| GPU fields empty | No `nvidia-smi`. Only NVIDIA is supported. |
| `cannot read the size of <path>` on a download | The base64 fallback could not stat the remote path — usually a wrong path or a permissions problem. The local file is left untouched. |
| WSL `Wsl/E_ACCESSDENIED` on `wsl.exe` | A restricted Windows sandbox blocks the named pipe `wsl.exe` needs. SSH into the distribution's sshd still works, which is why `channel: auto` tries SSH first. |
| `service ... usually needs root` | The account has no privilege. Use an account with rights, or for a WSL target set `user: root` (`wsl.exe -u root` needs no password). `sudo` cannot work over this non-interactive channel — there is no TTY to read a password from. |
