---
name: remote-panel-troubleshooting
description: 排查 dsh-remote-panel 自身的问题——某个远程/WSL 目标一直离线、探测超时、WSL 冷启动太慢、MCP 服务器没起来、WinUI 面板打不开或空白。当「连不上」「一直转圈」「状态不更新」「面板没反应」这类现象需要定位到具体环节时使用。
whenToUse: 目标状态一直是 offline/unknown；探测反复超时；面板窗口打不开、空白或显示解析失败；MCP 工具没出现在列表里；刚装完插件想确认装对了。
---

# 排查 dsh-remote-panel

链路是**分层**的，每一层失败的表现都不一样。按下面的顺序逐层确认，
不要一上来就改配置 —— 多数「连不上」是 key/权限/端口问题，不是插件问题。

```
配置 ──→ 目标解析 ──→ 传输(ssh / wsl.exe) ──→ 远程 shell 采集 ──→ 解析 ──→ 状态文件 ──→ 面板/工具
```

## 第 0 步：先看插件自己怎么说

```
/wsx list
```

它同时给出**配置目标清单**、每个目标走哪条通道，以及最后一行
**「工具注册路径」** —— 这一行直接决定后面怎么排查：

| 显示 | 含义 |
| --- | --- |
| `defineTool` | 官方助手可用，工具 schema 经过校验（正常） |
| `raw (defineTool unavailable: ...)` | 退回原始 JSON Schema 路径；**工具照常能用**，只是少了额外校验 |
| `raw (defineTool rejected <工具名>: ...)` | schema 没通过官方校验，但已用原始路径注册成功 |

看到 `raw` 不是故障。只有当工具**完全没出现在** `cordis_inspect_query` 的
`Tool.listTools` 里，才需要查注册。

## 第 1 步：配置有没有被读到

```
/wsx status
```

如果顶部出现「配置问题」，它的每一行就是一条被跳过的目标，并**带原因**，例如：

- `targets[0].kind must be "ssh" or "wsl"` —— 拼写错了
- `targets[1] (lab-01): kind=ssh requires "host"` —— 少了 host
- `duplicate target id "web"` —— 两个目标推出了同一个 id

单个目标配错**不会**让插件加载失败，所以这类问题只在这里或面板的错误条里才看得到。

## 第 2 步：手工验证链路（绕开插件）

这一步最关键：它把「插件的问题」和「链路的问题」彻底分开。
**插件的行为就是下面这条命令的封装**，所以手工能通、插件不通，才是插件的问题。

### SSH 目标

```powershell
# 用和插件完全一样的选项手工连一次
ssh -o BatchMode=yes -o ConnectTimeout=10 -o NumberOfPasswordPrompts=0 -- user@192.168.1.50 'echo OK'
```

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `Permission denied (publickey)` | 没配免密 | 把公钥放进目标机 `~/.ssh/authorized_keys`，或确认 ssh-agent 里有对应的 key（`ssh-add -l`） |
| `Connection timed out` | 网络/防火墙/端口 | 确认 IP 与端口；`Test-NetConnection <ip> -Port 22` |
| `Host key verification failed` | 目标机换过密钥 | 清掉 `~/.ssh/known_hosts` 里那一行；或在目标配置里写 `strictHostKeyChecking: false`（**只在可信网络这么做**） |
| `Connection closed by ...` | 目标机 sshd 拒了这次会话 | 看目标机 `/var/log/auth.log` |

> **插件永远不弹密码提示**（它给 ssh 传了 `BatchMode=yes`）。
> 因为无 TTY 的子进程一旦等密码，表现就是「永远超时」。
> 所以**要么用密钥/agent，要么先手工确认能免密登录**。

### WSL 目标

WSL 有两条通道，现象完全不同：

```powershell
# A) 直接走 wsl.exe
wsl.exe -d Ubuntu-24.04 -u root -- echo OK

# B) 走 WSL 里的 sshd（wsl-link 部署的那条）
ssh -i "$env:USERPROFILE\.dsh\skills\wsl-link\scripts\wsl_key" -o BatchMode=yes -o StrictHostKeyChecking=no -p 2222 -- <你的WSL用户名>@127.0.0.1 'echo OK'
```

| A 的结果 | B 的结果 | 结论 |
| --- | --- | --- |
| 通 | 任意 | 用 `channel: wsl` 或 `auto` 都行 |
| `Wsl/E_ACCESSDENIED` | 通 | **正常**。受限沙箱不让 `wsl.exe` 走命名管道，用 `channel: ssh`（或保持 `auto`，它会自动落到 SSH） |
| `Wsl/E_ACCESSDENIED` | 不通 | 发行版没跑 sshd。按 `wsl-link` 技能跑一次它的 `setup-wsl-sshd.sh`，或让本会话具备完全访问权限 |
| 超时 | 不通 | 发行版冷启动中（见下）；给**该目标的** `timeoutMs` 加码 |

### WSL 冷启动：最常见的一类「假故障」

WSL 在最后一次 `wsl.exe` 会话结束后**约一分钟就把整个发行版拆掉**。
所以空闲一段时间后的第一次调用要付 **16–88 秒**冷启动代价，
而紧跟其后的调用不到 1 秒（本机热探测实测 1.7–4.3s）。

判断方法：看 `remote_status` 返回里的 `latencyMs`，以及目标上的 `woke` 标记
（耗时 ≥ 10s 的 WSL 探测会被自动标成冷启动，悬浮窗会打一个「冷启动」角标）。

- 第一次很大、后面很小 → 就是冷启动，**不是故障**。
- 每次都很大 → 才是链路问题。

两个选择：

1. **接受它**（默认）：`timeoutMs` 全局默认已经是 `60000`，通常不用动；
   某个目标还需要更长就用 `targets[].timeoutMs` 单独给它加。
2. **消除它**：在 `%USERPROFILE%\.wslconfig` 的 `[wsl2]` 段加
   `vmIdleTimeout=3600000`。实测能把跨 80 秒的 8 次调用做到 0 失败，
   代价是发行版常驻约 1.4 GB 内存。

## 第 3 步：采集层

链路通了但指标是空的／缺项，通常是**目标机缺命令**或**不是类 Unix 系统**：

| 现象 | 原因 |
| --- | --- |
| 完全没有 CPU/内存 | 目标不是 POSIX 主机（没有 `/proc`）—— 当前探测脚本只支持 Linux/类 Unix |
| 磁盘列表为空 | 该机器 `df` 输出格式异常，或只有伪文件系统（tmpfs/overlay 已被刻意过滤掉） |
| `docker.available: true` 但计数为空 | 装了 docker 但读不到 `/var/run/docker.sock`（当前用户不在 `docker` 组）—— 返回里会带 docker 的原话 |
| GPU 为空 | 没装 `nvidia-smi`。目前只支持 NVIDIA |
| 返回里带 `warnings` | 采集被截断或不完整，工具会如实标注，不会假装数据是完整的 |

## 第 4 步：状态文件与面板

面板是**只读**消费者，所以「面板不对」几乎总是状态文件的问题。

```powershell
# 状态文件在不在、新不新、schema 对不对
$p = "$env:USERPROFILE\.dsh\remote-panel\state.json"
Test-Path $p
(Get-Item $p).LastWriteTime
(Get-Content $p -Raw | ConvertFrom-Json).host.pluginVersion
(Get-Content $p -Raw | ConvertFrom-Json).totals
```

| 面板显示 | 含义 | 处理 |
| --- | --- | --- |
| `还没找到状态文件` | 宿主插件没加载，或 profile 不对 | 确认 bundle 已启用；`/wsx list` 能出结果就说明插件在跑 |
| `状态文件解析失败：<字段>` | schema 对不上 | 面板会把具体字段报出来 —— 通常意味着状态文件是别的版本写的 |
| `DSH 宿主没有心跳` | 15 秒没有新快照 | 宿主进程挂了或卡住；看 DSH 日志 |
| `宿主已停止` | 读了 `dispose()` 写的最后一帧 | 正常收尾，不是故障 |
| `找不到面板可执行文件` | 没构建 `dist/WsxPanel.exe` | 在插件目录跑 `.\build.ps1 -Pack`，或在配置里用 `appPath` 指定绝对路径 |

**孤儿面板**：DSH 退出后面板会继续显示最后一份快照。
它自带 `--exit-after-stale 90`，宿主心跳消失 90 秒后自行关闭 —— 这是有意的。
手动关掉它不会影响 DSH；`/wsx panel` 随时能再叫回来。

## 网页面板（侧边栏「远程目标」图标）

网页面板走宿主注册的三条同源路由：

| 路由 | 方法 | 用途 |
| --- | --- | --- |
| `/dsh-remote-panel/snapshot` | GET / POST | 读当前快照（面板每 1.5 秒轮询一次） |
| `/dsh-remote-panel/probe` | POST | 立刻探测（面板上「立即探测」按钮） |
| `/dsh-remote-panel/open` | POST | 拉起 WinUI 悬浮窗 |

### 用命令行（curl / Invoke-WebRequest）测这些路由会得到 403 —— 这是正常的

DSH 的网页服务有**页面鉴权守卫**，它在请求到达插件路由之前就会拦下未认证的请求：

```
$ curl -i http://127.0.0.1:19387/dsh-remote-panel/snapshot
HTTP/1.1 403 Forbidden
dsh web authentication required; reopen the URL printed by dsh web.
```

因为浏览器页面加载的是 `dsh web` 打印出来的那条**带凭据的 URL**，之后同源请求都带着
会话，所以面板本身不受影响。命令行裸请求没有这个会话，于是被守卫拦掉 ——
**这不能用来判断插件路由有没有注册成功**。

想验证路由确实注册了，看这两处而不是 curl：

1. 浏览器里打开侧边栏的「远程目标」图标，面板应该显示目标卡片；
2. 或者读状态文件（`/wsx status`）—— 宿主半正常工作时它一定在更新。

### 如果浏览器里面板是空白／一直「正在读取」

| 现象 | 原因 |
| --- | --- |
| 面板一直「正在读取状态文件…」 | 宿主插件没在跑（状态文件不存在）。先看 `/wsx status` |
| 面板显示「无法读取快照：HTTP 403」 | 页面不是从 `dsh web` 打印的那条带凭据的 URL 打开的 |
| 侧边栏没有那个图标 | 包没启用，或页面没重新加载（客户端模块是 bootstrap 时装配的） |
| 点了图标中央栏没反应 | `sidebar.panellist` 的 `id` 与 `main` 的 `key` 不一致（两者靠这个配对） |

## 第 5 步：MCP 服务器MCP 那行是从**宿主插件写出的解析后配置**读目标的：

```
%USERPROFILE%\.dsh\remote-panel\config.resolved.json
```

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| MCP 工具没出现 | `args` 指向的 `bin/mcp-server.js` 不存在 | patch 里那段 `!!js` 依赖 `DSH_PROFILE_DIR`；用 `dsh --profile <名字> --dump-config` 看它解析成了什么 |
| MCP 里目标清单为空 | 宿主插件还没跑过（那份 config 文件是它写的） | 先把 DSH 跑起来让宿主插件落一次配置，MCP 侧才有目标 |
| MCP 里目标清单和 DSH 不一致 | 读到了旧的那份 | 重启 MCP 客户端；宿主每次启动都会重写它 |

手工验证 MCP 服务器（不经过 DSH）：

```powershell
$env:DSH_WSX_CONFIG = '{"config":{"targets":[{"kind":"wsl","distro":"Ubuntu-24.04","channel":"wsl","user":"root"}]}}'
# 然后往它 stdin 写一行 JSON-RPC，看 stdout 的应答
'{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | node .\bin\mcp-server.js
```

`stdout` 只应该有协议 JSON；诊断信息全在 `stderr`。如果 `stdout` 里混进了别的字符，
协议会直接坏掉 —— 加日志时务必写 `stderr`。

## 第 6 步：写操作被拒

| 报错 | 含义 |
| --- | --- |
| `refusing "<操作>": ... allowMutations=false` | 配置里的写操作总闸关着。改成 `true` 或去掉这一行 |
| `kill_process requires "confirm": true` | 这是**独立于**总闸的另一道闸，必须显式确认 |
| `refusing to signal PID 1` | 有意保护：杀 PID 1 会把整台机器带走 |
| `service ... usually needs root` | 权限不够。SSH 用有权限的账号，WSL 把 `user` 配成 `root` |

## 改动怎么生效

- **改 `cordis.patch.yml` 的 config** → 重启 DSH。
- **改 `lib/*.js`** → 重启 DSH（热重载不跟踪 profile `node_modules` 里这份插件的源码）。
- **改 `skills/*.md`** → 实时生效（技能目录带 chokidar 监视）。
- **改 WinUI 面板的 C#** → 在 `app/` 里重新 `dotnet publish`，然后重开窗口。
- **改 `bin/mcp-server.js`** → 重启 DSH（重新拉起 MCP 子进程）。

想确认「现在跑的到底是哪一份代码」，读状态文件里的
`host.pluginVersion` 和 `host.revision`。
