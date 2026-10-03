# 更新日志

本文件记录 `dsh-remote-panel` 的每个版本。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.1.1] —— 修正与加固

一次针对**宿主侧 JavaScript** 的质量/健壮性/性能专项复查。没有改设计、没有加依赖，
但修掉了几个「看起来一切正常」的真 bug。

### 修复

- **CPU 使用率永远是 0%（最严重的一个）。** 旧公式在远程 awk 里算
  `db=(u2-i2)-(u1-i1)`，也就是「user 增量 − idle 增量」；idle 增量在真机上几乎总是
  远大于 user 增量，于是 db 恒为负、被夹到 0。**实测同一采样窗口的真实忙碌度是
  46.7%，插件报的是 0%** —— 而 0% 看起来完全正常，所以一直没被发现。
  现在 `probe.sh` 只发两次 `/proc/stat` 的原始计数器（`user..steal` 之和、idle、iowait），
  百分比由 `lib/probe.js` 的 `cpuUsagePercent()` 按 `100% − 空闲 − iowait` 计算。
  公式搬到 JS 的直接好处是**可以用固定样本做回归测试**（远程 shell 里的算术测不了）。
- **`facts.cpuModel` / `facts.cpuCount` 解析出来又被丢掉。** 面板的 CPU 那一行正是
  「型号 ×核心数」（`app/ViewModels.cs`），`app/StateValidator.cs` 也在校验这两个键 ——
  于是那一行永远是空的。现在它们真的进了 `facts`（并且只发整数：面板的 schema 校验
  对 `cpuCount` 要求整数，非整数会拒收**整份**快照，所以宁可让这个字段缺席）。
- **失败样本从来没进过历史。** `markOffline()` 调的是 `pushHistory(0)`，而
  `pushHistory()` 见到 0 立刻返回 —— 注释里写的「趋势线在失败处断开」从未发生过。
  现在失败会推入一条 `latencyMs=0`、不带 cpu/mem 的断点（带上旧值会伪装成一次正常采样）。
- **心跳写盘频率是配置的 4 倍。** `writeSnapshot(force)` 的 `force` 参数从头到尾没被读过，
  于是 `tick()` 每 `flushIntervalMs`（默认 500ms）就 `JSON.stringify` 整份历史并同步写盘，
  `heartbeatMs`（默认 2000）等于死配置。现在只在「心跳到期」或「数据真的变了」时写。
- **启动错峰会被第一次 tick 抢跑。** `nextProbeAt` 初始为 0（=「立刻到期」），
  而 tick 每 500ms 跑一次，所以一次性加载时第一轮就把 `maxConcurrentProbes` 个目标
  同时探了 —— 错峰只在最初 500ms 内有效。现在错峰时间同时写进 `nextProbeAt`。
- **面板的「冷启动」角标永远不会亮。** 它的唯一输入是 `woke`，而代码写的是
  `reason === 'wake'`，调用方只会传 `startup` / `scheduled` / `manual`。
  现在按耗时判定：`kind: wsl` 且耗时 ≥ 10s（实测热探测 1.7–4.3s、冷启动抓到过 16.6s）。
- **下载的 base64 回退会静默写出损坏的文件。** `runProcess` 对 stdout 有上限保护且超限时
  **只保留尾部**，而回退路径把 stdout 直接解码写盘；注释里写着的「用 `wc -c` 校验」
  在代码里根本不存在。现在先取远程文件大小 → 超过 8MB 明确拒绝 →
  解码后逐字节比对 → 用「临时文件 + rename」原子替换本地文件，失败绝不动原文件。
- **上传的 base64 回退会先把目标文件截断。** `base64 -d > 目标` 中途失败会留下半截文件，
  而调用方看到的是「失败」。现在写同目录临时文件 → 校验字节数 → `chmod` → `mv -f` 原子替换；
  内联上限从 48MB（峰值内存可能几百 MB）收到 8MB。
- **scp 成功但 `chmod` 失败被当成整体成功。** 现在会作为 warning 一路带到工具摘要里。
  另外删掉了一次「scp 成功后再 `mkdir -p` 父目录」的无用往返。
- **`remote_*` 工具会替你在有歧义的选择器里挑第一台机器**，而 `/wsx` 会报错 ——
  同一个选择器在两条路径上可能指向不同的目标机。现在两边共用
  `config.requireTargetSelector()`：精确匹配 → 唯一片段，歧义一律拒绝并列出候选。
- **`remote_exec` / `/wsx exec` 把失败原因丢了。** 超时时 stderr 是空的，而
  「timed out after 3s … cold WSL start …」这句在 `run.error` 里 —— 代码只看
  stdout/stderr，于是调用方看到的是 `exit null`（`/wsx exec` 则是「退出码 —」）
  加上 `(no output)`。现在超时/链路失败都会把原因带出来，`data` 里也多了
  `timedOut` 与 `error` 两个字段。
- **`remote_exec` 不认目标级超时。** 它一直用全局 `config.timeoutMs`，
  于是给某个目标设的 `targets[].timeoutMs` 对「在这台机器上跑命令」不生效。
- **`docker logs` 失败也报成功**（错误被塞进 `data.error`），与其它操作不一致；
  现在和其它操作一样抛错，并给出「用 docker ps 核对容器名」这类可操作提示。
- **`ls -l` 列表的 `truncated` 会误报。** 它拿「过滤 `.`/`..` 之后的条数」跟上限比，
  刚好满一屏时会报 `false`。现在多取 4 行并按真实条数判断。
- **`readRemoteFile` 的 `truncated` 会误报。** 它拿「解码后重新编码的长度」跟大小比，
  而 `head -c` 可能把多字节字符切成两半（解码成 U+FFFD 后变长）—— 现在直接跟字节上限比。
- **`docker logs` 的 `truncated` 会误报**（行数恰好等于上限时）。现在多要一行再判断。
- **scp 的 IPv6 目标串少了方括号。** scp 按第一个冒号切 `host:path`，裸的 `::1`
  会被解析成空主机名，直接失败。只有 scp 走这个目标串，ssh 那条路是独立 argv，不受影响。
- **`ControlPath` 超长会让每次探测都失败。** 注释写着「限制在 90 字符内」，代码却没检查。
  现在真的检查：能用短的定长哈希就用，连目录本身都太长时**放弃连接复用**而不是让探测全挂。
- **`enabled: false` 是死配置**（没人读它）。现在它真的会停掉所有探测，并明确告诉你
  「目标会一直是 unknown」。
- **网页路由的 POST body 读取没有真正设限**：超出上限只是「提前 resolve」，
  `data` 监听还在，客户端继续发就继续累积；定时器也没清、没 unref。现在超限即截断 +
  卸载监听 + 销毁请求。
- **宿主启动时静默吞掉注册失败**（`safe()` 包住命令/工具/路由注册）。现在会告警 ——
  否则现象只是「/wsx 不存在」，没有任何线索。
- **状态文件写失败的告警每 2 秒刷一次**（磁盘满时会一直刷）。现在只在错误变化时报一次，
  并在恢复时报一次。
- **`pruneUndefined` 会把非普通对象压成 `{}`**（`Date` / `Buffer` 按 key 展开就是空对象），
  属于静默丢数据。现在只递归普通对象与数组。
- **原子写的临时文件在 rename 失败后会留在数据目录里**（心跳级频率会让它堆积）；
  临时文件名也加了自增序号，避免同一毫秒内的两次写互相截断。
- **MCP 服务器的 `initialize` 会把客户端要的协议版本原样回显**（注释写的却是
  「回一个我们确定支持的版本」），等于对一个不支持的版本假装达成一致。现在只在
  支持的版本集合内回显，否则回 `2024-11-05`。
- **MCP 服务器的 stdin 缓冲无上限**：一个不带换行的超长输入就能把内存吃光。
  现在超过 8MB 就丢弃并**重新同步到下一个换行**（只清空缓冲是不够的 ——
  那段垃圾的剩余字节会粘到下一条合法消息前面，把它变成解析错误）。

### 优化

- **`timeoutMs` 默认保持 60000，但新增目标级覆盖 `targets[].timeoutMs`。**
  复核证据：本机稳态探测 1.7–4.3s（channel: wsl，连续 5 次），而冷启动实测抓到过 16.6s
  （README「坑 2」记的范围是 16–88s）；「机器真的宕了」由 `connectTimeoutMs`（10s）先兜住，
  所以 60s 只对「连得上但很慢」的目标生效 —— 那恰好就是冷启动的形状。
  结论是**不降全局默认**（降了就是重踩旧坑），但把选择权交给目标级覆盖。
  顺带修掉 README 里那张已经过时的表（写的是 20000，代码是 60000）。
- 心跳写盘频率从 4× 降到 1×（见上），探测间隔 15s 的场景下少掉约 3 次/秒的
  整份快照序列化 + 同步写盘。
- `remote_status` 以前对同一个目标解析 2–3 次选择器，现在只解析一次。
- `runProcess` 的 stdout 上限可以按调用指定：文件下载那条路显式放宽到与 8MB 内联上限匹配，
  而不是在默认 8MB 处被静默截断。
- 删掉死代码：`gpuMemoryToBytes()`（没有任何调用点）、`serviceStatus()` 里
  「names 为空」的死分支（它还返回了拼错的键名）、`serviceRunner()`、
  `buildHelpers()` 里命令/工具都没用到的四个转发项、`manager` 里重导出但没人 import 的
  `targetLabel`、`controlPathFor()` 永远为 0 的 `index` 参数、`ops.js` 里的 `requireOk()`。
- `resolveTargetSelector()` 从 `ops.js` 搬到 `config.js`：它跟远程 I/O 无关，
  而 manager、工具、命令三条路径必须共用同一份语义。
- `/wsx` 只配一个目标时可以直接省略目标名（以前报 `no target matching ""`）；
  `/wsx exec` 现在接受任意空白分隔（制表符以前会被判成用法错误）。

### 测试

- `unit.test.mjs` 31 → **69** 项：新增 CPU 公式（含「旧公式必然得到 0」这条对照）、
  `facts.cpuModel/cpuCount`、失败样本进历史、心跳写盘频率、冷启动错峰、
  `enabled:false`、目标选择歧义、IPv6 scp 目标串、ControlPath 长度、
  内联传输命令形状与准入判断、`ls` 解析截断、`windowTail`、
  原子写收尾、`pruneUndefined` 非普通对象、`readBody` 上限、/wsx 文案与空白处理，
  以及一次把命令/工具/三条路由都真的装配一遍的 `apply()` 集成测试
  （含「注册失败必须出声」这条）。
- `lossless.test.mjs` 5 → **10** 项：面板真正读取的 `facts` 字段必须无损、
  歧义/未知目标必须是干净失败、`remote_panel` 的 action 必须校验。
- `smoke.test.mjs` 14 → **26** 项：真实 WSL 上跑通 `readRemoteFile`（字节上限与截断）
  与 `listRemoteDirectory`（条数与截断判定），断言 `facts.cpuCount/cpuModel`，
  并用「目标级 3s 超时 + `sleep 6`」证明目标级超时真的传到了传输层
  （超时结果必须自带原因、且仍然是无损 JSON）。
- `mcp.test.mjs` 19 → **24** 项：不支持的协议版本不得被回显、
  失败的工具调用必须是 MCP error、**9MB 无换行垃圾之后连接仍然可用**。

## [0.1.0] —— 首个版本

### 新增

**连接**
- SSH 通道：spawn 系统 OpenSSH 客户端，**复用 `~/.ssh/config`、ssh-agent 与 known_hosts**，
  所以使用者本来配好的免密登录直接生效。启用 `ControlMaster` 连接复用（热探测约 80ms）。
- WSL 通道：`wsl.exe -d <distro> -- sh -s`，脚本经 stdin 送入。
- `channel: auto`：先试 SSH，失败再落 `wsl.exe`。
- 目标支持按 `id` / 名称 / 主机名 / 唯一片段指定。

**采集（只读）**
- 单条远程命令完成一轮采集：CPU 使用率（两次 `/proc/stat` 采样，间隔 1 秒）、
  负载、内存与 swap、按占用率排序的磁盘、NVIDIA GPU、Docker 计数、
  CPU/内存 Top 进程、systemd 运行中的服务。
- 输出分节协议 + `trap ... EXIT` 保证的 `@@@END` 完成标记，
  所以「跑完了但某项没数据」与「根本没跑完」可区分。
- 任何一节解析失败只降级为「这一项没有数据」，不会让整次探测失败。

**调度**
- 并发上限、离线指数退避（上限 8×）、冷启动错开、无条件心跳落盘。
- 快照原子写入（临时文件 + rename），读者永远读不到半截 JSON。

**面板**
- WinUI 3（C#/.NET 8）置顶悬浮窗 `WsxPanel.exe`：每目标卡片显示状态、CPU/内存/磁盘条、
  GPU、Docker 计数、进程与错误条；按窗口尺寸分层自适应；跟随系统明暗；
  单实例互斥体；位置/大小/设置持久化。
- 浏览器面板：DSH 侧边栏「远程目标」图标 + 中央栏实时面板 + 侧边栏底部「打开悬浮窗」按钮。
  样式只用宿主主题 token（`--dsw-alias-*`），自动跟随明暗，无硬编码颜色。

**智能体面**
- DSH 会话命令 `/wsx`（`status` / `list` / `probe` / `docker` / `services` / `ps` / `exec` / `panel` / `open`）。
- 7 个原生工具：`remote_status` / `remote_exec` / `remote_files` / `remote_docker` /
  `remote_services` / `remote_processes` / `remote_panel`。
- 零依赖 MCP stdio 服务器（`bin/mcp-server.js`），与原生工具**共用同一份
  `TOOL_SPECS` 与实现**，所以两边行为与闸门完全一致。
- 两个 Skills：`remote-panel`（用法）与 `remote-panel-troubleshooting`（分层排查）。

**安全**
- `allowMutations` 写操作总闸；`kill` 另有一道独立的 `confirm: true` 闸，且硬拒 PID 1。
- 命令注入面收敛到唯一的 `shq()` 单引号转义入口，单测覆盖 `;`、`&&`、`|`、
  `$(...)`、反引号、重定向、换行与引号。
- 服务名/容器名走字符白名单校验，违者拒绝而不是转义后放行。
- 网页路由加回环信任栅栏（逐段校验 Host、拒跨站、Origin 必须同源、非 POST 405、异常 fail closed）。

**测试**
- `unit.test.mjs`（31 项）：命令注入面、配置规范化、采集解析、schema 方言投影、SSH 参数构造。
- `client.test.mjs`（10 项）：浏览器半契约，含「侧边栏 id 必须等于中央栏 key」这条关键配对。
- `smoke.test.mjs`（14 项）：真实 WSL 上走通采集全链路。
- `mcp.test.mjs`（19 项）：MCP 协议与错误码。

### 已知限制

- 只支持类 Unix 目标（依赖 `/proc`、`df`、`ps`），Windows 目标机不支持。
- GPU 只支持 NVIDIA。
- 不做「同一目标并发写」的保护。
- `remote_exec` 的命令是否只读由调用方判断。
- 仅 Windows 有悬浮窗。
