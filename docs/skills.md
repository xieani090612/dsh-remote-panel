# Skills

<!-- 中文 | English -->
**中文** ｜ [English](#english)

两个内置 agent Skill 各自覆盖什么、它们放在哪里，以及如何安装或修改。

Skill 是插件*给模型的指令*，与它的工具和命令相对。它们承载的是工具描述装不下的操作判断力：该优先选哪条通道、第一次探测很慢意味着什么，以及如何把一句"连不上"收敛到某一层。

| Skill | 覆盖内容 |
| --- | --- |
| `remote-panel` | 日常使用：先确认目标、工具速查表、三条安全约束、status / exec / docker / services / processes / files 的实例演练、WSL 各条通道、WSL 冷启动，以及什么时候*不*该用这个插件。 |
| `remote-panel-troubleshooting` | 针对插件自身的分层诊断：config → 目标解析 → 传输 → 采集 → 状态文件 → 网页面板 → MCP → 被拒绝的写操作，另外还有哪些改动需要重启 DSH。 |

两者都是带 YAML front matter 的纯 Markdown。没有构建步骤，也没有运行时依赖。

---

## 它们放在哪里

插件在以下位置随包提供：

```
skills/remote-panel/SKILL.md
skills/remote-panel-troubleshooting/SKILL.md
```

DSH 从**默认扫描根目录**发现它们：

```
$DSH_HOME/skills/remote-panel/SKILL.md
$DSH_HOME/skills/remote-panel-troubleshooting/SKILL.md
```

设置了 `DSH_HOME` 环境变量时，`$DSH_HOME` 就是它；否则是 `%USERPROFILE%\.dsh`。
所以在默认的 Windows 安装上，路径是
`%USERPROFILE%\.dsh\skills\remote-panel\SKILL.md` 和
`%USERPROFILE%\.dsh\skills\remote-panel-troubleshooting\SKILL.md`。

### 安装它们

bundle patch 携带的是插件行和配置，而不是文件，所以这两个 skill **不会**被自动挂载——把两个目录复制进扫描根目录一次：

```powershell
$dest = if ($env:DSH_HOME) { $env:DSH_HOME } else { "$env:USERPROFILE\.dsh" }
Copy-Item -Recurse -Force .\skills\remote-panel, .\skills\remote-panel-troubleshooting "$dest\skills\"
```

用 `Get-ChildItem "$dest\skills"` 验证——应该能看到这两个目录名。除此之外无需任何配置：DSH 的 preset 已经拥有一行 `skill-filesystem`，它会扫描这个根目录。

### 插件为什么不用 `customSkillDirs` 挂载它们

这一点值得直说，因为它是最容易先想到的做法，而且它不可能奏效。

DSH 的 web-app 层刻意禁用了 skills 的基础 host 行
（在 `dsh-web-app/cordis.patch.yml` 里 `skill-filesystem` 和 `tool-skill` 都是
`disabled: true`），并附了一条注释说明本地发现权归 preset 所有。非
`insert` 的 patch 只会赋值它携带的那些键，因此一个只携带
`config:` 的 bundle patch 永远清不掉那个 `disabled` 标志。在那里设置 `customSkillDirs` 会是死配置。

所以受支持的路径就是默认扫描根目录：`$DSH_HOME/skills/`。如果你想让插件自带的那份成为权威，把上面两个目录做成
`C:\path\to\dsh-remote-panel\skills\*` 的链接或副本即可。

---

## Front matter

两个文件都只声明三个键：

```yaml
---
name: remote-panel
description: <one sentence, used for skill discovery — what this skill can do>
whenToUse: <the triggers: WSL, a remote host, a server, an SSH host, an IP address, ...>
---
```

| 键 | 必需 | 用途 |
| --- | --- | --- |
| `name` | 是 | agent 加载的 skill 标识符。必须与目录名一致。 |
| `description` | 是 | 用于发现的那句话。写得具体——模型就是拿它来匹配任务的。 |
| `whenToUse` | 可选 | 用于选择的额外触发措辞。两个内置 skill 都用了它。 |

正文要短到一遍就能读完。一个比它所描述的任务还长的 skill，在真正需要的时候不会被加载。

---

## 修改它们立即生效

skill 根目录是被监视的，所以**修改 `SKILL.md` 不需要重启 DSH**：

| 改动 | 需要重启吗？ |
| --- | --- |
| `$DSH_HOME/skills/**/SKILL.md` | 不需要——watch 会实时拾取 |
| `docs/`、`README.md` | 对运行时完全没影响 |
| `cordis.patch.yml` 配置 | 需要 |
| `lib/*.js` | 需要——热重载不跟踪 profile 的 `node_modules` 下的插件源码 |
| `bin/mcp-server.js` | 需要——它是子进程，必须重新 spawn |

所以可行的循环是：改插件的 `skills/` 副本，重跑上面的复制命令，agent 无需重启就能看到新文本。直接改 `$DSH_HOME/skills/` 下已安装的那份也行，但下一次复制会覆盖它——把插件副本当作唯一事实来源。

---

## 这两个 skill 与插件其余部分的关系

| | 提供 | 受众 |
| --- | --- | --- |
| `remote-panel` skill | *何时以及如何*使用这项能力 | 模型 |
| `remote-panel-troubleshooting` skill | *如何定位一处故障* | 模型，在出问题的时候 |
| `remote_*` 工具（见 [commands.md](commands.md)） | 能力本身 | 模型 |
| `/wsx` 命令 | 同一种能力，以对齐文本呈现 | 提示符前的人 |
| MCP 服务器（见 [mcp.md](mcp.md)） | 同样的工具，面向任意 MCP 客户端 | 其他 agent |

这两个 skill 有意描述*工具*，而不是 MCP 传输——在模型看来，两个入口都是同样的七个操作、同样的闸门。

---

## 排障

| 症状 | 原因 | 怎么办 |
| --- | --- | --- |
| skill 始终不加载 | 文件还只在插件的 `skills/` 目录里 | 把它们复制进 `$DSH_HOME/skills/`；patch 不会替你做 |
| skill 加载了，但正文是旧的 | 扫描根目录里躺着一份更旧的副本 | 重跑复制命令，或直接改 `$DSH_HOME/skills/...` |
| `name` 与目录不一致 | 手工改了其中一个 | 让它们完全一致——这种配对关系正是 skill 的识别方式 |
| front matter 没被解析 | 缺少 `---` 围栏，或用了 tab 而不是空格 | YAML front matter 必须在第 0 列以 `---` 开始和结束 |
| 改 `$DSH_HOME/skills/` 下的文件似乎没反应 | 你改的是插件副本，不是被扫描的那份（或者反过来） | `Get-ChildItem -Recurse "$dest\skills"`，确认 agent 实际读的是哪个文件 |

---

[↑ 回到中文](#skills)

<a id="english"></a>

# Skills (English)

What the two bundled agent Skills cover, where they live, and how to install or edit them.

Skills are the plugin's *instructions to the model*, as opposed to its tools and commands. They
carry the operational judgement that a tool description is too small to hold: which channel to
prefer, what a slow first probe means, and how to narrow a "cannot connect" report down to one
layer.

| Skill | Covers |
| --- | --- |
| `remote-panel` | Everyday use: confirm targets first, the tool quick-reference, the three safety constraints, worked examples for status / exec / docker / services / processes / files, the WSL channels, the WSL cold start, and when *not* to use the plugin at all. |
| `remote-panel-troubleshooting` | Layered diagnosis of the plugin itself: config → target resolution → transport → collection → state file → web panel → MCP → refused write operations, plus which edits need a DSH restart. |

Both are plain Markdown with YAML front matter. There is no build step and no runtime dependency.

---

## Where they live

The plugin ships them at:

```
skills/remote-panel/SKILL.md
skills/remote-panel-troubleshooting/SKILL.md
```

DSH discovers them from the **default scan root**:

```
$DSH_HOME/skills/remote-panel/SKILL.md
$DSH_HOME/skills/remote-panel-troubleshooting/SKILL.md
```

`$DSH_HOME` is the `DSH_HOME` environment variable when set, and `%USERPROFILE%\.dsh` otherwise.
So on a default Windows install the paths are
`%USERPROFILE%\.dsh\skills\remote-panel\SKILL.md` and
`%USERPROFILE%\.dsh\skills\remote-panel-troubleshooting\SKILL.md`.

### Installing them

A bundle patch carries plugin rows and config, not files, so the skills are **not** mounted
automatically — copy the two directories into the scan root once:

```powershell
$dest = if ($env:DSH_HOME) { $env:DSH_HOME } else { "$env:USERPROFILE\.dsh" }
Copy-Item -Recurse -Force .\skills\remote-panel, .\skills\remote-panel-troubleshooting "$dest\skills\"
```

Verify with `Get-ChildItem "$dest\skills"` — you should see both directory names. Beyond that,
nothing needs configuring: DSH's preset already owns a `skill-filesystem` row that scans this
root.

### Why the plugin does not mount them via `customSkillDirs`

This is worth stating plainly, because it is the obvious first thing to try and it cannot work.

DSH's web-app layer deliberately disables the base host rows for skills
(`skill-filesystem` and `tool-skill` are both `disabled: true` in
`dsh-web-app/cordis.patch.yml`), with a comment saying that local discovery is owned by the
preset. A non-`insert` patch only assigns the keys it carries, and a bundle patch that carries only
`config:` can therefore never clear that `disabled` flag. Setting `customSkillDirs` there would be
dead configuration.

So the supported path is the default scan root: `$DSH_HOME/skills/`. If you want the plugin's own
copy to be authoritative, make the two directories above links or copies of
`C:\path\to\dsh-remote-panel\skills\*`.

---

## Front matter

Both files declare exactly three keys:

```yaml
---
name: remote-panel
description: <one sentence, used for skill discovery — what this skill can do>
whenToUse: <the triggers: WSL, a remote host, a server, an SSH host, an IP address, ...>
---
```

| Key | Required | Purpose |
| --- | --- | --- |
| `name` | yes | The skill identifier the agent loads. Must match the directory name. |
| `description` | yes | The discovery sentence. Keep it concrete — this is what a model matches a task against. |
| `whenToUse` | optional | Extra trigger phrasing for selection. Both bundled skills use it. |

Keep the body short enough to be read in one pass. A skill that is longer than the task it
describes does not get loaded when it matters.

---

## Editing them takes effect live

The skill root is watched, so **editing `SKILL.md` needs no DSH restart**:

| Change | Restart needed? |
| --- | --- |
| `$DSH_HOME/skills/**/SKILL.md` | No — the watch picks it up live |
| `docs/`, `README.md` | No effect on the runtime at all |
| `cordis.patch.yml` config | Yes |
| `lib/*.js` | Yes — hot reload does not track plugin source under the profile's `node_modules` |
| `bin/mcp-server.js` | Yes — it is a child process that has to be re-spawned |

So the workable loop is: edit the plugin's `skills/` copy, re-run the copy command above, and the
agent sees the new text without a restart. Editing the installed copy under `$DSH_HOME/skills/`
directly works too, but the next copy overwrites it — keep the plugin copy as the source of truth.

---

## How the two skills relate to the rest of the plugin

| | Provides | Audience |
| --- | --- | --- |
| `remote-panel` skill | *When and how* to use the capability | the model |
| `remote-panel-troubleshooting` skill | *How to localise a failure* | the model, when something is wrong |
| `remote_*` tools (see [commands.md](commands.md)) | the capability itself | the model |
| `/wsx` commands | the same capability as aligned text | a human at the prompt |
| MCP server (see [mcp.md](mcp.md)) | the same tools to any MCP client | other agents |

The skills intentionally describe the *tools*, not the MCP transport — from the model's point of
view both entry points are the same seven operations with the same gates.

---

## Troubleshooting

| Symptom | Cause | What to do |
| --- | --- | --- |
| The skill never loads | The files are still only in the plugin's `skills/` directory | Copy them into `$DSH_HOME/skills/`; the patch does not do it for you |
| The skill loads but the body is stale | An older copy sits in the scan root | Re-run the copy command, or edit `$DSH_HOME/skills/...` directly |
| `name` does not match the directory | Hand-editing one of the two | Make them identical — that pairing is how the skill is identified |
| Front matter not parsed | Missing `---` fences, or a tab instead of spaces | YAML front matter must open and close with `---` at column 0 |
| Edits under `$DSH_HOME/skills/` appear to do nothing | You edited the plugin copy, not the scanned one (or vice versa) | `Get-ChildItem -Recurse "$dest\skills"` and confirm which file the agent actually reads |
