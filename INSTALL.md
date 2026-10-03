# 安装 dsh-remote-panel

<!-- 中文 | English -->
**中文** ｜ [English](#english)

一份面向首次安装的分步指南。占位符约定：`C:\path\to\dsh-remote-panel` 是你解包插件的位置，`%USERPROFILE%` 是你的 Windows 主目录，`$DSH_HOME` 是 DSH 的数据目录（默认 `%USERPROFILE%\.dsh`）。

> ### ⚠ 最后一定要重启 DSH —— 这一步不是可选的
> 这个插件是一个 DSH **bundle**（`package.json` → `dsh.bundle.patch` → `cordis.patch.yml`）。
> bundle 的改动只在启动时组装 profile 配置树的那一刻生效，所以**在你重启 DSH 之前，插件本身、
> 它的 `/wsx` 命令、它的 `remote_*` 工具，以及它的 MCP 那一行都不会出现。** 如果装完立刻敲 `/wsx`
> 却提示“命令不存在”，原因几乎总是这个。改动 `cordis.patch.yml`（包括目标列表）或插件的
> JavaScript 之后，同样必须重启。

---

## 1. 前置条件

| | 用来做什么 | 说明 |
| --- | --- | --- |
| **DSH**，且带插件系统（bundle 机制 + `dsh.client`） | 一切功能 | 插件是 bundle；不支持 bundle 的旧版 DSH 加载不了它。 |
| **Windows 10 1809（build 17763）或更新** | 仅桌面面板 | WinUI 3 的要求。`/wsx`、工具、MCP 和 Skills 都与平台无关。 |
| **Windows OpenSSH 客户端**（`ssh.exe`、`scp.exe`） | `kind: ssh` 目标，以及走 SSH 的 WSL 目标 | Windows 10 1809+ 自带。用 `ssh -V` 验证。插件会先找 `%SystemRoot%\System32\OpenSSH\ssh.exe`，再找 `/usr/bin/ssh`，最后才找 `PATH` 上的 `ssh`；`ssh.executable` 可以覆盖以上全部。 |
| **对每个目标都免密（密钥 / agent）认证** | 任何目标 | **插件会带上 `BatchMode=yes`，因此永远不可能弹出密码提示。** 先自己验证一遍 —— 这是首次运行最常见的失败原因（见 [§9](#9-common-first-run-problems)）。 |
| **一个本地 WSL 发行版** | `kind: wsl` 目标 | 只有你确实配置了这类目标才需要。 |
| **.NET 8 SDK** | 从源码构建面板 | **仅当** `dist\WsxPanel.exe` 缺失时才需要。**不需要** Visual Studio。 |
| **Node.js 20+** | 跑测试 | `package.json` 里写了 `engines.node >= 20`。DSH 自带的 Node 就够用。 |

要让插件*跑起来*，什么都不用装：它没有任何运行时 npm 依赖（只用 Node 内置模块），`dist/` 里面的面板也是自包含的。

**检查你的前置条件：**

```powershell
ssh -V                                   # OpenSSH client present?
ssh -o BatchMode=yes user@192.168.1.50 'echo OK'   # key/agent auth working? (per target)
Test-Path .\dist\WsxPanel.exe            # panel prebuilt? (run from the plugin folder)
node --version                           # Node 20+ (only for tests)
dotnet --list-sdks                       # .NET 8 SDK (only if you must build the panel)
```

---

## 2. 安装

在下面几条路线里**挑一条**。它们最终都以同一次重启收尾。

### 2a. DSH 插件管理器（推荐）

1. 打开 DSH 插件管理器。
2. 选择从**路径**添加/安装插件，指向你解包的文件夹 ——
   给它加上 `link:` 前缀，这样 profile 会引用你的文件夹，而不是复制一份：

   ```
   link:C:\path\to\dsh-remote-panel
   ```

3. 如果弹出确认，批准这次安装。
4. **重启 DSH。**

`link:` 的意思是“就地使用那个目录”，当你想改插件、重启后立刻看到效果时这样最方便。去掉前缀，profile 就会保留自己的一份副本。

### 2b. `install.ps1`

这个辅助脚本替你处理那些琐碎环节：校验包结构，把两个 Skills 复制到 DSH 默认的 skill 扫描根目录，用 `dsh plugin add` 注册 bundle（当 `PATH` 上没有 `dsh` 命令时，就直接改写 profile 的 `package.json`），并在动 profile 清单之前先备份它。

```powershell
cd C:\path\to\dsh-remote-panel
pwsh -File .\install.ps1                       # profile "desktop", $DSH_HOME = %USERPROFILE%\.dsh
pwsh -File .\install.ps1 -Profile desktop      # pick another profile by name
pwsh -File .\install.ps1 -NoSkills             # do not copy the Skills
pwsh -File .\install.ps1 -DshHome 'D:\dsh'     # non-default DSH home
```

它实际做了哪些事：

- 包不完整时它拒绝继续（会检查 `package.json`、`cordis.patch.yml`、`lib\index.js`、`lib\client.js`、`bin\mcp-server.js`、`scripts\probe.sh`）。
- `dist\WsxPanel.exe` 缺失时它只警告、不失败 —— 没有桌面面板，命令和工具照样可用。见 [§4](#4-verify-the-install)。
- profile 必须已经存在。如果不存在，先启动一次 DSH 让它把 profile 建出来，再重跑脚本。
- 修改 profile 的 `package.json` 之前，它会先复制成 `package.json.bak`，所以你可以手工回滚。
- 结束时它会提醒你重启 DSH。

**然后重启 DSH。**

### 2c. 手动安装

当你想看清每一步到底改了什么，或者另外两条路线都走不通时，用这条。

1. **在 profile 里注册 bundle。** 要么走 CLI：

   ```powershell
   dsh plugin --profile desktop add C:\path\to\dsh-remote-panel
   # or, for local development where edits should apply without reinstalling:
   dsh plugin --profile desktop add link:C:\path\to\dsh-remote-panel
   ```

   ……要么手工编辑 `%USERPROFILE%\.dsh\profiles\desktop\package.json`：把这个包加进 `dependencies`，把它的名字加进 bundle 列表，然后安装依赖。

   ```jsonc
   {
     "dependencies": {
       "dsh-remote-panel": "link:C:/path/to/dsh-remote-panel"
     },
     "dsh": {
       "profile": {
         "bundles": [
           // ...existing bundles...
           "dsh-remote-panel"
         ]
       }
     }
   }
   ```

   bundle 列表是一个分层栈；这个插件不依赖别的插件，所以把它追加到末尾是安全的。注意 `link:` 这条 spec 里用的是正斜杠 —— 那才是包 spec 的常规写法。

   接着在 profile 目录里安装依赖：

   ```powershell
   cd $env:USERPROFILE\.dsh\profiles\desktop
   pnpm install     # or: npm install
   ```

2. **复制 Skills** 到 DSH 默认的 skill 扫描根目录（bundle 替你做不了这件事 ——
   原因见 `cordis.patch.yml` 里的注释）：

   ```powershell
   $skills = "$env:USERPROFILE\.dsh\skills"
   New-Item -ItemType Directory -Force -Path $skills | Out-Null
   Copy-Item C:\path\to\dsh-remote-panel\skills\remote-panel            "$skills\" -Recurse -Force
   Copy-Item C:\path\to\dsh-remote-panel\skills\remote-panel-troubleshooting "$skills\" -Recurse -Force
   ```

   如果你用了非默认的 `$DSH_HOME`，目标位置就是 `$DSH_HOME\skills`。

3. **确认面板可执行文件存在** —— 要么用发布包里的预编译版本
   （`dist\WsxPanel.exe`），要么用你自己构建的（§7）。缺了它，除桌面窗口外的一切照常工作。

4. **编辑目标列表**，然后**重启 DSH**。见
   [README → 配置目标](README.md#configuring-targets)。

### 2d. 从发布归档安装

维护者的构建会产出两份归档，各自配一个 `.sha256` 文件 —— 安装前先校验，因为两份归档都没有签名：

| 归档 | 面向 | 安装方式 |
| --- | --- | --- |
| `dsh-remote-panel-<version>.zip` | “下载、解包、跑脚本” | 解包到任意位置（例如 `C:\path\to\dsh-remote-panel`），然后在里面跑 `pwsh -File .\install.ps1`（路线 2b）。它已经包含 `dist\` 里预编译的面板，因此不需要 .NET SDK。 |
| `dsh-remote-panel-<version>.tgz` | 包管理器安装 | `dsh plugin --profile desktop add file:C:\path\to\dsh-remote-panel-<version>.tgz`，然后重启 DSH。 |

校验下载：

```powershell
(Get-FileHash .\dsh-remote-panel-0.1.1.zip -Algorithm SHA256).Hash.ToLower()
Get-Content .\dsh-remote-panel-0.1.1.zip.sha256
```

注意 zip 有意省掉的东西：`app/` 源码、`test/`，以及维护者自己的 `release.ps1`。用来安装和运行没问题，但它意味着**你无法从发布归档里跑测试套件** —— 那需要克隆/复制整个仓库。

---

## 3. 至少配置一个目标

bundle 自带一个示例 WSL 目标。打开 profile 的 `cordis.patch.yml`，编辑 `dsh-remote-panel` 那一行的 `config.targets`：把示例里的发行版/主机换成你自己的机器。一个最小的 `kind: ssh` 目标只需要 `host` 和 `user`。

```yaml
- id: dsh-remote-panel
  name: dsh-remote-panel
  config:
    targets:
      - kind: ssh
        name: lab-gpu-01
        host: 192.168.1.50
        user: ubuntu
        identityFile: ~/.ssh/id_ed25519
```

**保存后重启 DSH** —— 配置是在插件加载时读取的。

---

## 4. 验证安装

按顺序做这几步；每一步隔离的是不同的层。

### 4a. 命令存在

在一个 DSH 会话里敲：

```
/wsx
```

你应该看到一张状态表（目标可能仍显示 `unknown`/`probing`/`offline` —— 那是目标或凭据的问题，不是安装的问题）。然后是：

```
/wsx list
```

它会打印每个已配置的目标、各自使用的通道、生效的探测间隔 / 超时 / 并发度、写操作是否启用，以及一行**工具注册路径**（`defineTool` 或 `raw (...)`）。两条注册路径都正常 —— 见 README 里的说明。

如果 `/wsx` 根本不存在，那你要么没重启 DSH，要么 bundle 不在 profile 的 `bundles` 列表里。

### 4b. 状态文件正在被写入

```powershell
$p = "$env:USERPROFILE\.dsh\remote-panel\state.json"     # or $DSH_HOME\remote-panel\state.json
Test-Path $p
(Get-Item $p).LastWriteTime                              # should be within the last few seconds
(Get-Content $p -Raw | ConvertFrom-Json).host.pluginVersion
(Get-Content $p -Raw | ConvertFrom-Json).totals
```

这个文件至少每个 `heartbeatMs`（默认 2s）就要更新一次。`/wsx open` 会在资源管理器里打开数据目录（`$DSH_HOME\remote-panel`）。在 `state.json` 旁边你应该能找到 `config.resolved.json` —— 那是 MCP 服务器读取的规范化配置。

### 4c. Agent 工具已注册

让 agent 调用 `remote_status`。或者，如果你的 DSH 暴露了 inspection，就列出可用工具，找 `remote_status`、`remote_exec`、`remote_files`、`remote_docker`、`remote_services`、`remote_processes`、`remote_panel`。

### 4d. 桌面面板

```
/wsx panel
```

……或者用网页面板里的“打开桌面面板”动作。应该会弹出一个小的置顶窗口，渲染同一份快照。如果它报告找不到 `WsxPanel.exe`，见 [§9](#9-common-first-run-problems)。

---

## 5. Skills 落在哪里，以及如何确认它们被加载

| Skill | 目标位置 |
| --- | --- |
| `remote-panel` | `%USERPROFILE%\.dsh\skills\remote-panel\SKILL.md` |
| `remote-panel-troubleshooting` | `%USERPROFILE%\.dsh\skills\remote-panel-troubleshooting\SKILL.md` |

（如果你设置了 `DSH_HOME`，则是 `$DSH_HOME\skills\...`。）这是 DSH 的**默认 skill 扫描根目录**，所以 agent 不需要任何配置就能发现它们。

确认它们在那里：

```powershell
Get-ChildItem "$env:USERPROFILE\.dsh\skills" -Recurse -Filter SKILL.md |
  Select-Object FullName
```

预期：两条路径，一条在 `remote-panel` 下，一条在 `remote-panel-troubleshooting` 下。每个 `SKILL.md` 都以 YAML front matter 开头，其中包含 `name:` 和 `description:` —— 如果缺了这两行，或者目录名与 `name:` 对不上，这个 skill 就不会被发现。

之后 agent 会在它的 skill 目录里列出它们（例如 `remote-panel` 和 `remote-panel-troubleshooting`），并可按需加载任意一个。**Skill 内容是实时监听的：编辑 `SKILL.md` 无需重启即可生效。** 这一点和插件的代码、配置不同，后者确实需要重启。

如果你用了 `-NoSkills`，或者手动安装时跳过了 2c-2 步，就按上面的方式把那两个目录复制过去；它们不需要重启。

---

## 6. 启用 MCP 并确认 `mcp__remote_panel__*`

MCP 已经接好了：`cordis.patch.yml` 里还有第二个顶层 patch 行，它注册了一个名为 `remote_panel` 的 MCP stdio 服务器，复用 DSH 自带的 `@deepseek-ai/dsh-mcp-client`。所以并没有单独的“启用”开关 —— bundle 加载时你就得到了它，删掉那一行也就移除了它。没有别的东西依赖它：`/wsx`、`remote_*` 工具和各个面板在没有 MCP 的情况下都照常工作。

服务器进程本身是 `bin/mcp-server.js`。它自称服务器 `dsh-remote-panel`（版本 `0.1.1`），在 stdio 上用换行分隔的 JSON 讲 JSON-RPC 2.0，接受协议版本 `2024-11-05` 或 `2024-10-07`（对其他版本一律回 `2024-11-05`，而不是把不支持的版本原样回显），并且**只读**状态文件 —— 它从不写，所以不可能和宿主抢心跳。

1. **重启 DSH**（MCP 子进程是在 profile 启动时拉起的）。
2. 向你的客户端/agent 要工具列表，找带前缀的名字：

   ```
   mcp__remote_panel__remote_status
   mcp__remote_panel__remote_exec
   mcp__remote_panel__remote_files
   mcp__remote_panel__remote_docker
   mcp__remote_panel__remote_services
   mcp__remote_panel__remote_processes
   mcp__remote_panel__remote_panel
   ```

3. 如果这些名字没出现，**手工检查这个服务器**。这一步完全绕过 DSH：

   ```powershell
   cd C:\path\to\dsh-remote-panel
   $env:DSH_WSX_CONFIG = '{"config":{"targets":[{"kind":"wsl","distro":"Ubuntu-24.04","channel":"wsl","user":"root"}]}}'
   '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | node .\bin\mcp-server.js
   ```

   `stdout` 上出现一行协议 JSON，就说明服务器是健康的。诊断信息走 `stderr`；如果你要扩展那个文件，永远不要把日志写到 `stdout`。

如果这些工具还是不出现：

- patch 的 `args` 由 `DSH_PROFILE_DIR` 拼出，指向 `<profile>/node_modules/dsh-remote-panel/bin/mcp-server.js`。确认该路径存在。用 `link:` 方式安装时，它通过 profile 的 `node_modules` 链接解析；如果你是手工把包复制进 profile 的，要确保依赖装好了。
- MCP 的工具列表和 DSH 的工具列表都来自宿主插件：目标列表读自 `config.resolved.json`，而那个文件是宿主写的。如果宿主从未运行过，这个文件还不存在 —— 启动一次 DSH，让它写出一份快照。
- `mcp__remote_panel__remote_panel` 通过 MCP 调用时只支持 `action: "status"` —— 那个进程里没有窗口启动器。它会改为报告状态文件路径；`action: "open"` 会被拒绝并附带说明。

---

## 7. 构建面板（仅当 `dist\` 缺失，或你改过 C# 源码）

```powershell
cd C:\path\to\dsh-remote-panel
.\build.ps1            # Release build (development output under app\bin\...)
.\build.ps1 -Pack      # publish the self-contained panel into dist\
.\build.ps1 -Clean     # clear bin/obj/dist first
```

- **不需要 Visual Studio。** csproj 里设了 `EnableMsixTooling=true` + `WindowsPackageType=None`；只需要 .NET 8 SDK。把 `EnableMsixTooling=false` 会以 `MSB4062 ... ExpandPriContent` 失败，因为它会回落到只存在于 Visual Studio 里的 PRI 任务程序集。
- `-Pack` 直接覆写 `dist\`，而不是先删掉它，所以正在运行的面板永远不会指向一个短暂没有 exe 的目录。它还会保留 `dist\window.json`（面板记住的窗口大小/位置/设置）。
- 这次 publish 是自包含的（约 163 MB / 约 324 个文件）。你可以把 `dist/` 拷到另一台 Windows 机器上直接运行 —— 不需要 .NET 运行时、不需要 Windows App Runtime、不需要 MSIX。
- `-Pack` 之后脚本会给 exe 签名（除非 `-SkipSign`），并对发布出来的 exe 跑一次无头自检。见 [README → 签名](README.md#signing-be-aware-of-what-it-does-and-does-not-do)：
  这个 exe 默认没有签名，而自签名**并不能**可靠地消除 Windows 的“未知发布者”警告。
- （重新）构建之后，重启面板窗口（`/wsx panel`）。换一个重新构建的 exe 并**不**需要重启 DSH。

---

## 8. 升级与卸载

### 升级

1. 替换插件目录（或者更新你 profile 指向的那个位置）。
2. 如果发布包里带了新的 `dist\`，那它已经就位；否则跑 `.\build.ps1 -Pack`。
3. **重启 DSH。** 配置和代码的改动只在启动时被拾取。
4. 如果 Skills 有变化就重新复制一份（skill 内容本身是实时的，但 `$DSH_HOME\skills` 下的副本是快照 —— `pwsh -File .\install.ps1` 会刷新它们）：

   ```powershell
   pwsh -File .\install.ps1
   ```

用 `link:` 方式安装时，第 1 步就是“把新文件放进去” —— profile 不需要重新注册。以复制方式安装的插件则需要重新添加这个包。之后用 `/wsx list`，或从状态文件里读 `host.pluginVersion`，确认正在运行的版本。

### 卸载

```powershell
cd C:\path\to\dsh-remote-panel
pwsh -File .\install.ps1 -Uninstall
```

它会把这个包从 profile 的 `dependencies` 和 bundle 列表里移除（先把清单备份成 `package.json.bak`），并删掉 `$DSH_HOME\skills` 下复制进去的那两个 Skills。**重启 DSH** 以卸载它。

想手工做的话：

```powershell
dsh plugin --profile desktop remove dsh-remote-panel      # if the CLI supports remove
```

……或者编辑 `%USERPROFILE%\.dsh\profiles\desktop\package.json`，把依赖项和 bundle 列表项都删掉，然后重装 profile 依赖并重启 DSH。

可选的残留物，你可能想删掉：

- `$DSH_HOME\skills\remote-panel`、`$DSH_HOME\skills\remote-panel-troubleshooting`
- `$DSH_HOME\remote-panel\`（状态文件、`config.resolved.json`，以及存放 SSH 控制套接字的 `cm\` 目录）
- 如果你给面板做过自签名：`pwsh -File .\sign-panel.ps1 -Uninstall`（从当前用户的证书存储里移除证书；签名本身还留在 exe 里，但失去了信任链，效果等同于未签名）。

---

## 9. 常见的首次运行问题

| 现象 | 原因 | 修复 |
| --- | --- | --- |
| **`/wsx` 不存在 / "unknown command"** | bundle 没有被加载 —— 几乎总是因为安装之后没有重启 DSH。 | **重启 DSH。** 如果它仍然不存在，确认这个包在 profile 的 `bundles` 列表里，并且 DSH 日志里插件加载没有报错。 |
| **`/wsx list` 一个目标都不显示** | 没有配置任何 `targets` —— 随包发布的示例只是个例子；另外配置有问题（`kind` 写错、缺 `host`、`id` 重复）时，插件会丢掉出问题的那个目标，而不是让整次加载失败。 | 在 profile 的 `cordis.patch.yml` 里添加/修正 `config.targets`，然后重启 DSH。`/wsx status` 会打印每个被跳过的目标及其原因。 |
| **每个目标都停在 `unknown`，从来不被探测** | 插件配置里的 `enabled: false` 会关掉所有探测（插件照常加载，所以看起来像“什么都不工作”，而不是像配置错误）。 | 去掉 `enabled: false`（或改成 `true`）并重启 DSH。宿主日志在启动时会明确说明这一点。 |
| **某个目标永久 `offline`** | 没有免密认证：插件带上 `BatchMode=yes` 且**从不**提示，所以只支持密码的登录看起来就和超时一模一样。其他可能：主机/端口写错、防火墙、sshd 没在跑、host key 未知。 | 用同样的选项手工复现：`ssh -o BatchMode=yes -o ConnectTimeout=10 -o NumberOfPasswordPrompts=0 -- user@192.168.1.50 'echo OK'`。然后修好密钥/agent（用 `ssh-add -l` 检查 agent）。 |
| **某个 WSL 目标偶尔超时，或者延迟极大** | 冷启动 —— 最后一次 `wsl.exe` 会话结束约一分钟后，WSL 会把发行版拆掉，所以第一次探测要花 18–88s。 | 没什么要修的：全局 `timeoutMs` 默认值（60000）已经覆盖了它。面板会把这类探测标记为冷启动。想彻底消除这个代价，就在 `%USERPROFILE%\.wslconfig` 的 `[wsl2]` 下设 `vmIdleTimeout=3600000`（代价是约 1.4 GB 常驻内存）。 |
| **WSL 目标以 `Wsl/E_ACCESSDENIED` 失败** | `wsl.exe` 被 WSL 服务拒绝，因为 DSH 沙箱以 Low 完整性级别运行子进程。 | 保持 `channel: auto`（它会回落到 SSH），或者设 `channel: ssh` 并在发行版里部署一个 sshd（`wsl-link` skill 会在 `127.0.0.1:2222` 上做这件事）。 |
| **桌面面板缺失："cannot find the panel executable"** | `dist\WsxPanel.exe` 不存在 —— 这个包构建时没带面板，或者 `dist\` 没有被发布/解包出来。 | 跑 `.\build.ps1 -Pack`（只需要 .NET 8 SDK），或者把 `appPath` 指向一个已有的 `WsxPanel.exe`。`/wsx` 和工具都不需要面板。 |
| **面板启动时出现“Unknown publisher”安全警告** | 这个 exe 没有签名。 | 预期之内。`.\sign-panel.ps1` 会为当前用户给它自签名，常见情况下能消掉本机上的警告 —— 但**自签名并不能可靠地消除它**，而且只对当前机器上的当前用户有效。只有商业代码签名证书才能可靠地为其他人消除它。 |
| **面板窗口打开了，但是空的 / 显示 "no state file yet"** | 宿主插件没在跑，或者路径不对（例如宿主和面板启动时的 `DSH_HOME` 不一致）。 | 检查 `/wsx status` 和状态文件（§4b）。如果宿主写了快照而面板没显示，就去看那份快照里的 `host.stateFile`。 |
| **网页面板显示 "HTTP 403"** | 这个页面不是从 `dsh web` 打印出来的、带凭据的 URL 打开的。插件的路由还额外被限制为回环 + 同源。 | 打开 `dsh web` 打印的那个 URL。注意用 `curl` 测试这些路由同样会返回 403 —— 那是 DSH 的页面鉴权守卫，**并不**意味着路由注册失败。 |
| **侧边栏里没有 "remote targets" 图标** | bundle 没有被加载，或者启用之后页面没有重新加载（客户端模块是在引导阶段组装的）。 | 重启 DSH 并重新加载页面。 |
| **工具出现了，但 `/wsx list` 显示 `raw (...)`** | `@deepseek-ai/*` 这些包只存在于 `app.asar` 内部，所以第三方插件无法 `import('@deepseek-ai/dsh-tools')`；插件改走了裸 JSON Schema 的注册路径。 | 不是问题。两条路径行为完全一致；见 README 的 `/wsx` 一节。 |
| **`remote_processes` 拒绝执行 kill** | `kill` 有自己独立于 `allowMutations` 的门禁。 | 传 `confirm: true`，并先用 `operation: "list"` 核对 PID。PID 1 永远会被拒绝。 |
| **所有写操作都被拒绝** | 插件配置里 `allowMutations: false`。 | 把它设成 `true`（或删掉那一行）并重启 DSH。`remote_exec` / `/wsx exec` 是刻意*不*受这个开关管辖的。 |

这里没列到的问题，就顺着 `skills/remote-panel-troubleshooting/SKILL.md` 走一遍 —— 它是按层组织的（配置 → 链路 → 采集 → 状态文件 → MCP → 被拒绝的写操作），能把“连不上”收敛到某个具体的失败层。

---

## 接下来看哪里

- [README.md](README.md) —— 这个插件是什么、架构、完整的配置参考、WSL 通道/冷启动的解释、构建与签名、测试、已知限制。
- [docs/commands.md](docs/commands.md)、[docs/skills.md](docs/skills.md)、
  [docs/mcp.md](docs/mcp.md) —— 每个界面的更深入参考。
- `CHANGELOG.md` —— 每个版本改了什么。

---

[↑ 回到中文](#安装-dsh-remote-panel)

<a id="english"></a>

# Installing dsh-remote-panel (English)

A first-time, step-by-step guide. Placeholders: `C:\path\to\dsh-remote-panel` is wherever you
unpacked the plugin, `%USERPROFILE%` is your Windows home directory, and `$DSH_HOME` is DSH's
data directory (it defaults to `%USERPROFILE%\.dsh`).

> ### ⚠ Restart DSH at the end — this is not optional
> This plugin is a DSH **bundle** (`package.json` → `dsh.bundle.patch` → `cordis.patch.yml`).
> Bundle changes are applied when the profile's config tree is assembled at startup, so
> **the plugin, its `/wsx` command, its `remote_*` tools and its MCP row will not appear until
> you restart DSH.** If `/wsx` "does not exist" right after installing, this is almost always
> why. Restarting is also required after changing `cordis.patch.yml` (including the target
> list) or the plugin's JavaScript.

---

## 1. Prerequisites

| | Needed for | Notes |
| --- | --- | --- |
| **DSH**, with the plugin system (bundle mechanism + `dsh.client`) | everything | The plugin is a bundle; an older DSH without bundles cannot load it. |
| **Windows 10 1809 (build 17763) or newer** | the desktop panel only | WinUI 3's requirement. `/wsx`, the tools, MCP and the Skills are platform-independent. |
| **Windows OpenSSH client** (`ssh.exe`, `scp.exe`) | `kind: ssh` targets, and WSL targets over SSH | Ships with Windows 10 1809+. Verify with `ssh -V`. The plugin looks for `%SystemRoot%\System32\OpenSSH\ssh.exe` first, then `/usr/bin/ssh`, then `ssh` on `PATH`; `ssh.executable` overrides all of it. |
| **Passwordless (key/agent) auth to every target** | any target | **The plugin passes `BatchMode=yes` and can never prompt for a password.** Verify first — this is the single most common first-run failure (see [§9](#9-common-first-run-problems)). |
| **A local WSL distribution** | `kind: wsl` targets | Only if you configure any. |
| **.NET 8 SDK** | building the panel from source | **Only** if `dist\WsxPanel.exe` is missing. Visual Studio is *not* required. |
| **Node.js 20+** | running the tests | `package.json` sets `engines.node >= 20`. DSH's own bundled Node works fine. |

Nothing needs to be installed for the plugin to *run*: it has zero runtime npm dependencies
(Node builtins only), and the panel in `dist/` is self-contained.

**Check your prerequisites:**

```powershell
ssh -V                                   # OpenSSH client present?
ssh -o BatchMode=yes user@192.168.1.50 'echo OK'   # key/agent auth working? (per target)
Test-Path .\dist\WsxPanel.exe            # panel prebuilt? (run from the plugin folder)
node --version                           # Node 20+ (only for tests)
dotnet --list-sdks                       # .NET 8 SDK (only if you must build the panel)
```

---

## 2. Install

Pick **one** of the routes below. All of them end with the same restart.

### 2a. DSH Plugin Manager (recommended)

1. Open the DSH Plugin Manager.
2. Choose to add/install a plugin from a **path**, and point it at the folder you unpacked —
   prefix it with `link:` so the profile references your folder instead of copying it:

   ```
   link:C:\path\to\dsh-remote-panel
   ```

3. Approve the installation if prompted.
4. **Restart DSH.**

`link:` means "use that directory in place", which is convenient when you want to edit the
plugin and see the effect after a restart. Omit the prefix to have the profile keep its own
copy.

### 2b. `install.ps1`

The helper script does the fiddly parts for you: it validates the package structure, copies the
two Skills into DSH's default skill scan root, registers the bundle with `dsh plugin add` (or
writes the profile's `package.json` directly when no `dsh` command is on `PATH`), and backs up
the profile manifest before touching it.

```powershell
cd C:\path\to\dsh-remote-panel
pwsh -File .\install.ps1                       # profile "desktop", $DSH_HOME = %USERPROFILE%\.dsh
pwsh -File .\install.ps1 -Profile desktop      # pick another profile by name
pwsh -File .\install.ps1 -NoSkills             # do not copy the Skills
pwsh -File .\install.ps1 -DshHome 'D:\dsh'     # non-default DSH home
```

Notes on what it actually does:

- It refuses to continue if the package is incomplete (it checks `package.json`,
  `cordis.patch.yml`, `lib\index.js`, `lib\client.js`, `bin\mcp-server.js`, `scripts\probe.sh`).
- It warns (but does not fail) when `dist\WsxPanel.exe` is missing — commands and tools still
  work without the desktop panel. See [§4](#4-verify-the-install).
- The profile must already exist. If it does not, start DSH once so it creates the profile,
  then re-run the script.
- The profile's `package.json` is copied to `package.json.bak` before being modified, so you
  can roll back by hand.
- It ends by reminding you to restart DSH.

**Then restart DSH.**

### 2c. Manual install

Use this when you want to see exactly what changes, or when the other two routes are blocked.

1. **Register the bundle in the profile.** Either via the CLI:

   ```powershell
   dsh plugin --profile desktop add C:\path\to\dsh-remote-panel
   # or, for local development where edits should apply without reinstalling:
   dsh plugin --profile desktop add link:C:\path\to\dsh-remote-panel
   ```

   …or by editing `%USERPROFILE%\.dsh\profiles\desktop\package.json` by hand: add the package
   to `dependencies`, and add its name to the bundle list, then install dependencies.

   ```jsonc
   {
     "dependencies": {
       "dsh-remote-panel": "link:C:/path/to/dsh-remote-panel"
     },
     "dsh": {
       "profile": {
         "bundles": [
           // ...existing bundles...
           "dsh-remote-panel"
         ]
       }
     }
   }
   ```

   The bundle list is a layer stack; this plugin does not depend on other plugins, so
   appending it last is safe. Note the forward slashes in the `link:` spec — that is the
   normal form for package specs.

   Then install dependencies from the profile directory:

   ```powershell
   cd $env:USERPROFILE\.dsh\profiles\desktop
   pnpm install     # or: npm install
   ```

2. **Copy the Skills** into DSH's default skill scan root (the bundle cannot do this for you —
   see the comment in `cordis.patch.yml`):

   ```powershell
   $skills = "$env:USERPROFILE\.dsh\skills"
   New-Item -ItemType Directory -Force -Path $skills | Out-Null
   Copy-Item C:\path\to\dsh-remote-panel\skills\remote-panel            "$skills\" -Recurse -Force
   Copy-Item C:\path\to\dsh-remote-panel\skills\remote-panel-troubleshooting "$skills\" -Recurse -Force
   ```

   If you use a non-default `$DSH_HOME`, the destination is `$DSH_HOME\skills` instead.

3. **Make sure the panel executable exists** — either the prebuilt one from the release
   (`dist\WsxPanel.exe`) or your own build (§7). Without it everything works except the
   desktop window.

4. **Edit the target list**, then **restart DSH**. See
   [README → Configuring targets](README.md#configuring-targets).

### 2d. From a release archive

The maintainer build produces two archives, both accompanied by a `.sha256` file — check it
before installing, since neither archive is signed:

| Archive | Intended for | How to install |
| --- | --- | --- |
| `dsh-remote-panel-<version>.zip` | "download, unpack, run a script" | unpack it anywhere (e.g. `C:\path\to\dsh-remote-panel`), then run `pwsh -File .\install.ps1` from inside (route 2b). It already contains the prebuilt panel in `dist\`, so no .NET SDK is needed. |
| `dsh-remote-panel-<version>.tgz` | package-manager installs | `dsh plugin --profile desktop add file:C:\path\to\dsh-remote-panel-<version>.tgz`, then restart DSH. |

Verify a download with:

```powershell
(Get-FileHash .\dsh-remote-panel-0.1.1.zip -Algorithm SHA256).Hash.ToLower()
Get-Content .\dsh-remote-panel-0.1.1.zip.sha256
```

Note what the zip deliberately leaves out: `app/` sources, `test/`, and the maintainer's
`release.ps1`. That is fine for installing and running, but it means **you cannot run the test
suites from a release archive** — clone/copy the repository for that.

---

## 3. Configure at least one target

The bundle ships with a sample WSL target. Open the profile's `cordis.patch.yml` and edit the
`config.targets` of the `dsh-remote-panel` row: replace the sample distro/host with your own
machines. A minimal `kind: ssh` target needs only `host` and `user`.

```yaml
- id: dsh-remote-panel
  name: dsh-remote-panel
  config:
    targets:
      - kind: ssh
        name: lab-gpu-01
        host: 192.168.1.50
        user: ubuntu
        identityFile: ~/.ssh/id_ed25519
```

**Restart DSH after saving** — the config is read when the plugin loads.

---

## 4. Verify the install

Do these in order; each one isolates a different layer.

### 4a. The command exists

In a DSH session, type:

```
/wsx
```

You should get a status table (targets may still show `unknown`/`probing`/`offline` — that is a
target or credential question, not an install question). Then:

```
/wsx list
```

This prints every configured target, the channel each one uses, the effective probe interval /
timeout / concurrency, whether writes are enabled, and a **tool registration path** line
(`defineTool` or `raw (...)`). Both registration paths are fine — see the note in the README.

If `/wsx` does not exist at all, you have not restarted DSH, or the bundle is not in the
profile's `bundles` list.

### 4b. The state file is being written

```powershell
$p = "$env:USERPROFILE\.dsh\remote-panel\state.json"     # or $DSH_HOME\remote-panel\state.json
Test-Path $p
(Get-Item $p).LastWriteTime                              # should be within the last few seconds
(Get-Content $p -Raw | ConvertFrom-Json).host.pluginVersion
(Get-Content $p -Raw | ConvertFrom-Json).totals
```

The file should update at least every `heartbeatMs` (2s by default). `/wsx open` opens the
data directory (`$DSH_HOME\remote-panel`) in Explorer. Next to `state.json` you should find
`config.resolved.json` — that is the normalised config the MCP server reads.

### 4c. The agent tools are registered

Ask the agent to call `remote_status`. Or, if your DSH exposes inspection, list the available
tools and look for `remote_status`, `remote_exec`, `remote_files`, `remote_docker`,
`remote_services`, `remote_processes`, `remote_panel`.

### 4d. The desktop panel

```
/wsx panel
```

…or the "open the desktop panel" action in the web panel. A small always-on-top window should
appear, rendering the same snapshot. If it reports that it cannot find `WsxPanel.exe`, see
[§9](#9-common-first-run-problems).

---

## 5. Where the Skills land, and how to confirm they load

| Skill | Destination |
| --- | --- |
| `remote-panel` | `%USERPROFILE%\.dsh\skills\remote-panel\SKILL.md` |
| `remote-panel-troubleshooting` | `%USERPROFILE%\.dsh\skills\remote-panel-troubleshooting\SKILL.md` |

(`$DSH_HOME\skills\...` if you set `DSH_HOME`.) This is DSH's **default skill scan root**, so
no configuration is needed for the agent to discover them.

Confirm they are there:

```powershell
Get-ChildItem "$env:USERPROFILE\.dsh\skills" -Recurse -Filter SKILL.md |
  Select-Object FullName
```

Expected: two paths, one under `remote-panel`, one under
`remote-panel-troubleshooting`. Each `SKILL.md` starts with YAML front matter containing
`name:` and `description:` — if those two lines are missing or the directory name does not
match `name:`, the skill will not be discovered.

The agent will then list them in its skill catalog (for example `remote-panel` and
`remote-panel-troubleshooting`) and can load either on demand. **Skill content is watched live:
editing `SKILL.md` takes effect without a restart.** That is unlike the plugin's code and
config, which do need a restart.

If you used `-NoSkills`, or installed manually and skipped step 2c-2, copy the two
directories as shown above; no restart is needed for them.

---

## 6. Enabling MCP and confirming `mcp__remote_panel__*`

MCP is already wired up: `cordis.patch.yml` contains a second top-level patch row that
registers an MCP stdio server named `remote_panel`, reusing DSH's bundled
`@deepseek-ai/dsh-mcp-client`. So there is no separate "enable" switch — you get it when the
bundle loads, and you remove it by deleting that row. Nothing else depends on it: `/wsx`, the
`remote_*` tools and the panels all keep working without MCP.

The server process itself is `bin/mcp-server.js`. It identifies as server
`dsh-remote-panel` (version `0.1.1`), speaks JSON-RPC 2.0 over newline-delimited JSON on
stdio, agrees to protocol version `2024-11-05` or `2024-10-07` (and answers anything else with
`2024-11-05` rather than echoing an unsupported version), and **only reads** the state file —
it never writes it, so it cannot fight the host over heartbeats.

1. **Restart DSH** (the MCP child process is spawned at profile startup).
2. Ask your client/agent for the tool list and look for the prefixed names:

   ```
   mcp__remote_panel__remote_status
   mcp__remote_panel__remote_exec
   mcp__remote_panel__remote_files
   mcp__remote_panel__remote_docker
   mcp__remote_panel__remote_services
   mcp__remote_panel__remote_processes
   mcp__remote_panel__remote_panel
   ```

3. **Check the server by hand** if the names do not show up. This bypasses DSH entirely:

   ```powershell
   cd C:\path\to\dsh-remote-panel
   $env:DSH_WSX_CONFIG = '{"config":{"targets":[{"kind":"wsl","distro":"Ubuntu-24.04","channel":"wsl","user":"root"}]}}'
   '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | node .\bin\mcp-server.js
   ```

   One line of protocol JSON on `stdout` means the server is healthy. Diagnostics go to
   `stderr`; if you extend that file, never write logs to `stdout`.

If the tools still do not appear:

- The patch's `args` are built from `DSH_PROFILE_DIR` and point at
  `<profile>/node_modules/dsh-remote-panel/bin/mcp-server.js`. Confirm that path exists. With
  a `link:` install it resolves through the profile's `node_modules` link; if you copied the
  package into the profile manually, make sure dependencies were installed.
- The MCP tool list and the DSH tool list both come from the host plugin: the target list is
  read from `config.resolved.json`, which the host writes. If the host has never run, that
  file does not exist yet — start DSH once and let it write a snapshot.
- `mcp__remote_panel__remote_panel` only supports `action: "status"` when called over MCP —
  there is no window launcher in that process. It reports the state-file path instead;
  `action: "open"` is rejected with an explanation.

---

## 7. Building the panel (only if `dist\` is missing or you changed the C# sources)

```powershell
cd C:\path\to\dsh-remote-panel
.\build.ps1            # Release build (development output under app\bin\...)
.\build.ps1 -Pack      # publish the self-contained panel into dist\
.\build.ps1 -Clean     # clear bin/obj/dist first
```

- **No Visual Studio needed.** The csproj sets `EnableMsixTooling=true` +
  `WindowsPackageType=None`; only the .NET 8 SDK is required. Setting `EnableMsixTooling=false`
  fails with `MSB4062 ... ExpandPriContent` because it falls back to a Visual Studio-only
  PRI task assembly.
- `-Pack` writes straight over `dist\` rather than deleting it first, so a running panel is
  never left pointing at a directory that momentarily has no exe. It also preserves
  `dist\window.json` (the panel's remembered window size/position/settings).
- The publish is self-contained (~163 MB / ~324 files). You can copy `dist/` to another
  Windows machine and run it there — no .NET runtime, no Windows App Runtime, no MSIX.
- After `-Pack` the script signs the exe (unless `-SkipSign`) and runs a headless self-check
  against the published exe. See [README → Signing](README.md#signing-be-aware-of-what-it-does-and-does-not-do):
  the exe is unsigned by default, and self-signing does **not** reliably remove Windows'
  "unknown publisher" warning.
- After (re)building, restart the panel window (`/wsx panel`). A DSH restart is **not** needed
  for a rebuilt exe.

---

## 8. Upgrading and uninstalling

### Upgrading

1. Replace the plugin directory (or update whatever your profile points at).
2. If the release ships a new `dist\`, it is already there; otherwise run `.\build.ps1 -Pack`.
3. **Restart DSH.** Config and code changes are only picked up at startup.
4. Re-copy the Skills if they changed (skill content itself is live, but the copies under
   `$DSH_HOME\skills` are snapshots — `pwsh -File .\install.ps1` refreshes them):

   ```powershell
   pwsh -File .\install.ps1
   ```

With a `link:` install, step 1 is just "put the new files there" — the profile does not need
re-registering. Plugins installed by copy need the package re-added. Confirm the running
version afterwards with `/wsx list` or by reading `host.pluginVersion` from the state file.

### Uninstalling

```powershell
cd C:\path\to\dsh-remote-panel
pwsh -File .\install.ps1 -Uninstall
```

This removes the package from the profile's `dependencies` and from the profile's bundle list
(backing the manifest up to `package.json.bak`) and deletes the two copied Skills from
`$DSH_HOME\skills`. **Restart DSH** to unload it.

To do it by hand instead:

```powershell
dsh plugin --profile desktop remove dsh-remote-panel      # if the CLI supports remove
```

…or edit `%USERPROFILE%\.dsh\profiles\desktop\package.json` and drop both the dependency entry
and the bundle-list entry, then reinstall profile dependencies and restart DSH.

Optional leftovers you may want to delete:

- `$DSH_HOME\skills\remote-panel`, `$DSH_HOME\skills\remote-panel-troubleshooting`
- `$DSH_HOME\remote-panel\` (the state file, `config.resolved.json`, and the `cm\` directory
  holding SSH control sockets)
- If you self-signed the panel: `pwsh -File .\sign-panel.ps1 -Uninstall` (removes the
  certificate from the current user's stores; the signature bytes stay in the exe but lose
  their trust chain, which is equivalent to unsigned).

---

## 9. Common first-run problems

| Symptom | Cause | Fix |
| --- | --- | --- |
| **`/wsx` does not exist / "unknown command"** | The bundle was not loaded — almost always because DSH has not been restarted since installing. | **Restart DSH.** If it still does not exist, confirm the package is in the profile's `bundles` list and that the plugin loaded without error in the DSH log. |
| **`/wsx list` shows no targets at all** | No `targets` are configured — the shipped sample is only an example, and config problems (a bad `kind`, a missing `host`, a duplicate id) drop the offending target rather than failing the whole load. | Add/fix `config.targets` in the profile's `cordis.patch.yml`, then restart DSH. `/wsx status` prints each skipped target with its reason. |
| **Every target stays `unknown` and nothing is ever probed** | `enabled: false` in the plugin config disables all probing (the plugin still loads, so this looks like "nothing works" rather than a config error). | Remove `enabled: false` (or set it to `true`) and restart DSH. The host log says so explicitly at startup. |
| **A target is permanently `offline`** | No passwordless auth: the plugin passes `BatchMode=yes` and **never** prompts, so password-only login looks exactly like a timeout. Other candidates: wrong host/port, firewall, sshd not running, unknown host key. | Reproduce by hand with the same options: `ssh -o BatchMode=yes -o ConnectTimeout=10 -o NumberOfPasswordPrompts=0 -- user@192.168.1.50 'echo OK'`. Then fix the key/agent (`ssh-add -l` to check the agent). |
| **A WSL target times out occasionally, or its latency is huge** | Cold start — WSL tears the distribution down about a minute after the last `wsl.exe` session, so the first probe costs 18–88s. | Nothing to fix: the global `timeoutMs` default (60000) already covers it. The panel marks such a probe as a cold start. To remove the cost, set `vmIdleTimeout=3600000` under `[wsl2]` in `%USERPROFILE%\.wslconfig` (costs ~1.4 GB resident). |
| **WSL target fails with `Wsl/E_ACCESSDENIED`** | `wsl.exe` was refused by the WSL service because the DSH sandbox runs children at Low integrity. | Keep `channel: auto` (it falls back to SSH), or set `channel: ssh` and deploy an sshd in the distro (the `wsl-link` skill does this on `127.0.0.1:2222`). |
| **Desktop panel missing: "cannot find the panel executable"** | `dist\WsxPanel.exe` does not exist — the package was built without the panel, or `dist\` was not shipped/extracted. | Run `.\build.ps1 -Pack` (needs only the .NET 8 SDK), or point `appPath` at an existing `WsxPanel.exe`. `/wsx` and the tools do not need the panel. |
| **"Unknown publisher" security warning when the panel starts** | The exe is unsigned. | Expected. `.\sign-panel.ps1` self-signs it for the current user, which removes the warning on this machine in the common case — but **self-signing does not reliably remove it**, and it is only effective for the current user on this machine. Only a commercial code-signing certificate reliably removes it for other people. |
| **The panel window opens but is empty / shows "no state file yet"** | The host plugin is not running, or the path is wrong (e.g. `DSH_HOME` differs between the host and the panel launch). | Check `/wsx status` and the state file (§4b). If the host writes a snapshot but the panel does not, inspect `host.stateFile` inside that snapshot. |
| **The web panel shows "HTTP 403"** | The page was not opened from the credential-bearing URL `dsh web` prints. The plugin's routes are additionally fenced to loopback + same-origin. | Open the URL that `dsh web` printed. Note that testing the routes with `curl` also returns 403 — that is DSH's page-auth guard, and it does **not** mean the routes failed to register. |
| **The sidebar has no "remote targets" icon** | The bundle is not loaded, or the page was not reloaded after enabling it (client modules are assembled at bootstrap). | Restart DSH and reload the page. |
| **Tools appear, but `/wsx list` says `raw (...)`** | `@deepseek-ai/*` packages live only inside `app.asar`, so a third-party plugin cannot `import('@deepseek-ai/dsh-tools')`; the plugin registered through the raw JSON Schema path instead. | Not a problem. Both paths behave identically; see the README's `/wsx` section. |
| **`remote_processes` refuses to kill** | `kill` has its own gate independent of `allowMutations`. | Pass `confirm: true`, and verify the PID first with `operation: "list"`. PID 1 is always refused. |
| **Every write operation is refused** | `allowMutations: false` in the plugin config. | Set it to `true` (or remove the line) and restart DSH. `remote_exec` / `/wsx exec` are deliberately *not* covered by this switch. |

For anything not listed here, work through
`skills/remote-panel-troubleshooting/SKILL.md` — it is organised by layer
(config → link → collection → state file → MCP → refused writes), which turns "cannot connect"
into a specific failing layer.

---

## Where to go next

- [README.md](README.md) — what the plugin is, the architecture, the full config reference,
  the WSL channel/cold-start explanations, building and signing, tests, limitations.
- [docs/commands.md](docs/commands.md), [docs/skills.md](docs/skills.md),
  [docs/mcp.md](docs/mcp.md) — deeper reference for each surface.
- `CHANGELOG.md` — what changed in each version.
