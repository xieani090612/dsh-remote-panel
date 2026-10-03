---
name: remote-panel
description: 查看或操作本机 WSL 发行版与远程 SSH 机器（CPU/内存/磁盘/GPU/Docker/进程/服务/文件）。当任务需要跨机器状态、远程排障、或在 WSL / 远端 Linux 上做只读检查与运维操作时使用。
whenToUse: 需要了解某台机器（含本机 WSL）的实时负载、磁盘、容器状态时；需要把文件传到远端或取回时；需要重启远端服务/容器、或排查远端进程时；用户提到 WSL、远程主机、服务器、SSH、IP 地址时。
---

# 远程目标与 WSL 状态

本技能由 `dsh-remote-panel` 插件提供。它把「本机 WSL 发行版」和「指定 IP 的远程机器」
统一成一份**目标清单**，并给出三条等价的使用途径：

| 途径 | 使用者 | 说明 |
| --- | --- | --- |
| `remote_*` 工具 | 模型（你） | 结构化返回，参数有校验，**优先用这个** |
| `/wsx ...` 命令 | 人类 | 不经模型，直接出一张对齐好的文本表 |
| MCP `remote_panel` 服务器 | 任意 MCP 客户端 | 与 `remote_*` 工具同一份实现与闸门 |

## 第一步永远是确认目标

```
remote_status()
```

返回每个目标的 `id`、`name`、`kind`（`wsl` / `ssh`）、`status` 以及最新指标。
**后续所有工具都用这里的 `target` 值**（id、名称、主机名或它们的唯一片段都行）。

不要凭猜测写目标名 —— 名字解析不出来时工具会明确列出可用目标。
**片段命中多个目标时同样会拒绝并列出候选**（不会替你挑一台）：这种情况请写完整的 id。

## 工具速查

| 工具 | 用途 |
| --- | --- |
| `remote_status` | 目标总览；`refresh: true` 立刻重新探测 |
| `remote_exec` | 在目标上跑一条命令，回 stdout/stderr/退出码 |
| `remote_files` | `list` / `read` / `upload` / `download` |
| `remote_docker` | `ps` / `logs` / `start` / `stop` / `restart` / `pause` / `unpause` |
| `remote_services` | `status` / `start` / `stop` / `restart` / `reload`（systemd 或 sysvinit） |
| `remote_processes` | `list`（按 cpu/mem）与 `kill` |
| `remote_panel` | 显示 WinUI 3 状态预览窗口 |

## 三条安全约束（务必先看，再看下面的例子）

1. **`remote_processes` 的 `kill` 必须显式带 `confirm: true`**，否则一律被拒。
   杀进程按 PID 不可撤销，所以在按下去之前先用 `operation: "list"` 确认那个 PID
   确实是你要杀的那个（工具会回显它看到 `ps` 里的身份串，对不上就别按）。
2. **`allowMutations: false` 时所有写操作（docker 启停、服务启停、文件上传）都会被拒**，
   并明确说明是配置拦的。只有 `remote_exec` / `/wsx exec` 不受这个闸门约束，
   因为它们拿到的是一条任意命令，插件无法判断它是否只读 —— **所以命令的只读性由你负责**。
3. **`sudo` 在非交互通道上必然失败**（没有 TTY 读密码）。需要 root 时：
   WSL 目标把 `user` 配成 `root`（走 `wsl.exe -u root` 免密）；SSH 目标用有权限的账号或已配好的免密 sudo。

## 典型用法

### 一台机器现在有多忙

```
remote_status({ target: "wsl-ubuntu-2404", refresh: true })
```

`refresh: true` 会**等**这次探测结束，所以拿到的一定是即时数据；不带它就是最近一次采样的缓存。
回应里的 `latencyMs` 是本次链路耗时，能直观看出链路是快是慢。

### 远端排障：看日志和资源

```
remote_exec({ target: "lab-gpu-01", command: "systemctl --failed --no-pager" })
remote_exec({ target: "lab-gpu-01", command: "df -h / /var; free -m" })
remote_exec({ target: "lab-gpu-01", command: "journalctl -u myapp --since '30 min ago' -n 80 --no-pager" })
```

命令在目标的 POSIX shell 里执行，**整条作为一个字符串**传。不要试图在本地展开
`$(...)` 或反引号 —— 那些会被本地 shell 抢先求值。要引号就写进命令字符串里。

输出有上限（默认 64 KiB）。日志很大时先用 `head`/`tail`/`--since` 在远端裁剪，
而不是把整份拉回来。

### Docker

```
remote_docker({ target: "lab-gpu-01", operation: "ps" })
remote_docker({ target: "lab-gpu-01", operation: "logs", container: "api", lines: 200, since: "1h" })
remote_docker({ target: "lab-gpu-01", operation: "restart", container: "api" })
```

装了 docker 但 `docker ps` 报权限错误时，返回里会带 docker 自己的报错原文
（通常是当前用户不在 `docker` 组）。这属于「工具正常，权限不够」，不要当成插件故障。

### 服务

```
remote_services({ target: "prod-web-1", operation: "status", services: ["nginx", "postgresql"] })
remote_services({ target: "prod-web-1", operation: "restart", service: "nginx" })
```

想固定盯某几个服务，可以在目标的配置里写 `services: [...]`，
`operation: "status"` 不传 `services` 时会用它。

### 进程

```
remote_processes({ target: "lab-gpu-01", operation: "list", sort: "mem", limit: 20 })
remote_processes({ target: "lab-gpu-01", operation: "list", filter: "python" })
remote_processes({ target: "lab-gpu-01", operation: "kill", pid: 12345, confirm: true })
```

### 文件

```
remote_files({ target: "lab-gpu-01", operation: "list", remotePath: "/srv/app" })
remote_files({ target: "lab-gpu-01", operation: "read", remotePath: "/etc/nginx/nginx.conf" })
remote_files({ target: "lab-gpu-01", operation: "upload", localPath: "C:/tmp/deploy.tar.gz", remotePath: "/tmp/deploy.tar.gz", makeDirs: true })
remote_files({ target: "lab-gpu-01", operation: "download", remotePath: "/var/log/app.log", localPath: "C:/tmp/app.log", overwrite: true })
```

**远端路径必须是绝对路径**（以 `/` 开头）。相对路径在不同登录 shell 的 cwd 下落点不同，
所以插件直接拒绝，不猜。

上传下载默认走 `scp`；目标机没有 sftp-server 时自动回退到 base64 over SSH
（返回值里的 `via` 字段说明实际用了哪条）。**回退路径上限 8MB**：更大的文件会被明确拒绝，
而不是传回一份被截断的副本 —— 要传大文件就先在目标机修好 sftp-server。

### WSL 的两条通道

WSL 目标可以用两种方式抵达，配置里的 `channel` 决定：

| `channel` | 行为 | 什么时候合适 |
| --- | --- | --- |
| `auto`（默认） | 先试 SSH，失败再落 `wsl.exe` | 大多数情况 |
| `ssh` | 只走 SSH | 发行版里已跑 sshd（见下面的 wsl-link） |
| `wsl` | 只走 `wsl.exe` | 没装 sshd，且当前会话有完全访问权限 |

**重要：`wsl.exe` 在受限沙箱下会被 WSL 服务拒绝**（`Wsl/E_ACCESSDENIED`），
因为 `wsl.exe` 要走命名管道而沙箱不允许。这时 SSH 通道仍然可用 ——
本机的 `wsl-link` 技能在 `127.0.0.1:2222` 上部署了一个仅回环的 sshd，
所以 `channel: auto` 通常能自动落到那条路上。

### WSL 冷启动很慢（这是正常的）

WSL 在最后一次 `wsl.exe` 会话结束后约一分钟就拆掉整个发行版。
所以隔一段时间后的第一次调用可能付 **18–88 秒**的冷启动代价，
紧跟其后的调用则不到 1 秒。遇到 `remote_status` 里某个 WSL 目标
latency 特别大、或者探测超时，先怀疑冷启动，而不是链路坏了。

想消除这个代价，可以在 `%USERPROFILE%\.wslconfig` 的 `[wsl2]` 段加
`vmIdleTimeout=3600000`，代价是发行版常驻约 1.4 GB 内存。

## WinUI 3 状态预览窗口

```
remote_panel({ action: "open" })
```

在桌面打开一个置顶的悬浮窗，实时渲染同一份快照（每个目标的 CPU/内存/磁盘条、
Docker 计数、进程、错误条）。它和 `/wsx` 命令读的是同一个状态文件：

- 状态文件：`%USERPROFILE%\.dsh\remote-panel\state.json`
- 目标机连不上时窗口显示断线提示，而不是空白

## 什么时候不用这个技能

- 只是要看**本机 Windows** 的状态 —— 用 `pwsh` 直接跑 PowerShell cmdlet 更合适。
- 要在**当前工作区**读写文件 —— 用 `read` / `write` / `edit`，不要绕到远端去。
- 只是一次性的 `ping` / 端口探测 —— 本机的 `pwsh` 就够，不必过 SSH。
