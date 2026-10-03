# 真的把窗口拉起来、确认它活着、并截一张图。
#
#   .\test\gui-smoke.ps1 -Exe dist\WsxPanel.exe -StatePath <state.json> `
#                        -Shot docs\panel-wide-dark.png -Theme Dark -Width 620 -Height 640
#
# 做四件事：
#   1. 先把 window.json 写好（位置/大小/主题），让截图尺寸可复现；
#   2. 启动 exe，等 N 秒，断言进程还活着、并且**真的有一个窗口**（MainWindowHandle != 0）；
#   3. 可选：把窗口前置并截取它的矩形，存成 PNG；
#   4. 杀掉进程，把这次运行新产生的 panel.log 行打出来（排查用）。
#
# 需要桌面会话。截图走 System.Drawing 的 CopyFromScreen（面板默认置顶，所以不会被别的窗口盖住）。

param(
    [Parameter(Mandatory = $true)][string]$Exe,
    [string]$StatePath,
    [int]$Seconds = 8,
    [string]$Shot,
    [ValidateSet('Dark', 'Light', 'System')][string]$Theme = 'Dark',
    [int]$Width = 620,
    [int]$Height = 640,
    [int]$X = 8,
    [int]$Y = 8,
    [switch]$Compact,
    [switch]$RefreshGeneratedAt,
    [switch]$KeepRunning,
    # 关窗口而不是杀进程：走一遍 OnClosed，用来验证「位置/设置真的写盘了」。
    [switch]$GracefulClose,
    # 不预置 window.json，让面板用它自己的默认尺寸（440x620 DIP）——
    # 用来验证「默认窗口大小下，盘用量那串数字是完整的」。
    [switch]$UseAppDefaultPlacement
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

if (-not (Test-Path $Exe)) { throw "找不到 exe：$Exe" }
$Exe = (Resolve-Path $Exe).Path

if (-not ('WsxWin32' -as [type])) {
    Add-Type -Namespace '' -Name 'WsxWin32' -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool GetWindowRect(System.IntPtr hWnd, out RECT lpRect);
[DllImport("user32.dll")] public static extern bool GetClientRect(System.IntPtr hWnd, out RECT lpRect);
[DllImport("user32.dll")] public static extern uint GetDpiForWindow(System.IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(System.IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool ShowWindow(System.IntPtr hWnd, int nCmdShow);
[DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(System.IntPtr value);
[DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(System.IntPtr hWnd, int attr, out RECT value, int size);
[StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
'@
}

# 取窗口的**可见**边界。
#
# GetWindowRect 给的是「窗口矩形」，它把 DWM 那条看不见的、用来拖拽缩放的边框也算进去了，
# 在 125% 缩放下大约每边多 8 物理像素。照它截会把窗口外面（桌面/后面的窗口）一起拍进来 ——
# 我第一版截图右边那几列「半截字」就是这么来的，看着像布局溢出，其实是拍到了后面的浏览器。
# DwmGetWindowAttribute(DWMWA_EXTENDED_FRAME_BOUNDS=9) 给的才是真正画出来的边界。
function Get-VisibleRect {
    param([IntPtr]$Handle)
    $r = New-Object WsxWin32+RECT
    try {
        if ([WsxWin32]::DwmGetWindowAttribute($Handle, 9, [ref]$r, 16) -eq 0) { return $r }
    }
    catch { }
    [WsxWin32]::GetWindowRect($Handle, [ref]$r) | Out-Null
    return $r
}

# ---------------------------------------------------------------------------
# 关键：先把这个截图进程设成 PerMonitorV2 感知。
#
# 不设的话，PowerShell 是 DPI 不感知的，而面板自己是 PerMonitorV2：
#   * GetWindowRect 返回的是**虚拟化后**的坐标（本机 125% 缩放下，
#     一个 775x800 物理像素的窗口只会报 620x640）；
#   * CopyFromScreen 却按物理像素去抓 → 只截到窗口的左上 80%。
# 结果就是一张「右边和下面被裁掉」的图，看起来像是布局把内容顶出了窗口 ——
# 我第一次就是这么误判的。所以这一句不是可有可无的修饰。
# ---------------------------------------------------------------------------
$dpiAware = [WsxWin32]::SetProcessDpiAwarenessContext([IntPtr](-4))   # DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2
Write-Host ("截图进程 DPI 感知(PerMonitorV2) = {0}" -f $dpiAware) -ForegroundColor DarkGray

# ---- 1. window.json（位置/大小/主题） ----
$stateDir = Join-Path $env:LOCALAPPDATA 'DshWsxPanel'
New-Item -ItemType Directory -Force -Path $stateDir | Out-Null
$windowJson = Join-Path $stateDir 'window.json'
$logPath = Join-Path $stateDir 'panel.log'

# 面板读 window.json 时有**多条候选**，顺序是：exe 旁边 → 状态文件旁边 → %LOCALAPPDATA%。
# 只预置 %LOCALAPPDATA% 那一份是没用的：读取取的是第一个存在的，exe 旁边那份会赢。
# 所以这里对**所有**候选一起操作，截图尺寸才可复现。
function Get-PlacementCandidates {
    param([string]$ExePath, [string]$StateFile)
    $list = @()
    if ($ExePath) { $list += (Join-Path (Split-Path $ExePath -Parent) 'window.json') }
    if ($StateFile) {
        $dir = Split-Path $StateFile -Parent
        if ($dir) { $list += (Join-Path $dir 'window.json') }
    }
    $list += (Join-Path $env:LOCALAPPDATA 'DshWsxPanel\window.json')
    return ($list | Select-Object -Unique)
}

$placement = [ordered]@{
    X = $X; Y = $Y; Width = $Width; Height = $Height
    Topmost = $true; Compact = [bool]$Compact; Theme = $Theme
}
$candidates = Get-PlacementCandidates -ExePath $Exe -StateFile $StatePath
if ($UseAppDefaultPlacement) {
    # 所有候选都删掉：面板读不到就回落到内置默认 440x620 DIP。
    foreach ($candidate in $candidates) { Remove-Item $candidate -Force -ErrorAction SilentlyContinue }
    Write-Host '已清除所有 window.json 候选 —— 本次使用面板内置的默认窗口尺寸 440x620 DIP' -ForegroundColor DarkGray
}
else {
    foreach ($candidate in $candidates) {
        New-Item -ItemType Directory -Force -Path (Split-Path $candidate -Parent) | Out-Null
        ($placement | ConvertTo-Json) | Set-Content -Path $candidate -Encoding utf8NoBOM
    }
    Write-Host ("window.json 已写入 {0} 条候选（{1}x{2} @ {3},{4}, theme={5}, compact={6}）" -f `
        $candidates.Count, $Width, $Height, $X, $Y, $Theme, [bool]$Compact) -ForegroundColor DarkGray
    foreach ($candidate in $candidates) { Write-Host "        $candidate" -ForegroundColor DarkGray }
}

# ---- 可选：把 generatedAt 刷成现在，让状态栏显示「已连接」 ----
if ($RefreshGeneratedAt -and $StatePath -and (Test-Path $StatePath)) {
    $doc = Get-Content $StatePath -Raw | ConvertFrom-Json
    $doc.generatedAt = [long][DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    foreach ($t in $doc.targets) {
        if ($t.PSObject.Properties.Name -contains 'lastProbeAt' -and $t.lastProbeAt) {
            $t.lastProbeAt = $doc.generatedAt - 3200
        }
    }
    ($doc | ConvertTo-Json -Depth 16 -EscapeHandling Default) | Set-Content -Path $StatePath -Encoding utf8NoBOM
}

$logBefore = 0
if (Test-Path $logPath) { $logBefore = (Get-Content $logPath).Count }

# ---- 1.5 清场：单实例互斥体 ----
# 面板自带单实例互斥体（这是需求，也是正确行为）：只要已经有一个实例在跑，
# 新进程就会「唤醒它然后自己退出」，于是截图脚本会看到「进程立刻退出」。
# 实测踩到过：DSH 宿主插件按 --exit-after-stale 90 拉起了一个面板，
# 我后面几次验证启动全都被它挡掉了。所以测试前必须清场。
$existing = @(Get-Process WsxPanel -ErrorAction SilentlyContinue)
if ($existing.Count -gt 0) {
    Write-Host ("发现 {0} 个已在运行的 WsxPanel 实例（单实例互斥体会挡住本次启动）→ 先结束它们" -f $existing.Count) -ForegroundColor Yellow
    # 反复确认真的清干净为止：宿主插件（remote_panel 工具）可能在我们清理的同时又拉起一个，
    # 那样新进程会走「已有实例」分支、直接退出 0，截图就拍空了 —— 这已经误伤过两次验证。
    $deadline = (Get-Date).AddSeconds(10)
    while ((Get-Date) -lt $deadline) {
        $still = @(Get-Process WsxPanel -ErrorAction SilentlyContinue)
        if ($still.Count -eq 0) { break }
        $still | Stop-Process -Force -ErrorAction SilentlyContinue
        Start-Sleep -Milliseconds 500
    }
    $left = @(Get-Process WsxPanel -ErrorAction SilentlyContinue).Count
    Write-Host ("        清场完成，剩余 {0} 个" -f $left) -ForegroundColor DarkGray
    if ($left -gt 0) { throw "无法清空已在运行的 WsxPanel 实例（剩 $left 个）—— 单实例互斥体会让本次启动直接退出" }
}

# ---- 2. 启动 ----
$argList = @()
if ($StatePath) { $argList += @('--state', $StatePath) }
$argList += '--topmost'
if ($Compact) { $argList += '--compact' }

Write-Host ("启动：{0} {1}" -f $Exe, ($argList -join ' ')) -ForegroundColor Cyan
$proc = Start-Process -FilePath $Exe -ArgumentList $argList -PassThru
Write-Host ("pid = {0}" -f $proc.Id) -ForegroundColor DarkGray

# ---- 3. 存活断言 ----
$deadline = (Get-Date).AddSeconds($Seconds)
while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 400
    if ($proc.HasExited) { break }
}
$proc.Refresh()

if ($proc.HasExited) {
    Write-Host ("[FAIL] 进程在 {0}s 内退出了，ExitCode={1}" -f $Seconds, $proc.ExitCode) -ForegroundColor Red
    $alive = $false
}
else {
    $aliveFor = [math]::Round(((Get-Date) - $proc.StartTime).TotalSeconds, 1)
    Write-Host ("[ok]   进程存活 {0}s（要求 >= {1}s），ExitCode 未产生" -f $aliveFor, $Seconds) -ForegroundColor Green
    $alive = $true
}

# 窗口句柄要**轮询**着等：WinUI 的窗口是在消息循环起来之后才变成可见顶层窗口的，
# 而 Process.MainWindowHandle 会缓存第一次的结果。早先这里只读一次，
# 恰好撞上「刚 Activate()、还没被枚举到」的那一瞬间，就误报成「窗口没起来」，
# 接着 WM_CLOSE 发了个空句柄，只能强杀 —— 连带把 OnClosed 的保存路径也跳过了。
$hwnd = [IntPtr]::Zero
$hwndDeadline = (Get-Date).AddSeconds(12)
while ((Get-Date) -lt $hwndDeadline) {
    $proc.Refresh()
    if ($proc.HasExited) { break }
    $handle = $proc.MainWindowHandle
    # **必须核对标题**：MainWindowHandle 会返回「该进程的某个顶层窗口」，
    # 启动器/宿主环境下它可能给出别的窗口（parent 就踩到过：拿到的是 DSH 网页窗口，
    # 于是所有「内容跑到 x=454」的像素测量都在量错的那个窗口）。
    # 只有标题匹配面板才算数，否则继续等。
    if ($handle -ne [IntPtr]::Zero -and $proc.MainWindowTitle -like '*远程目标面板*') {
        $hwnd = $handle
        break
    }
    Start-Sleep -Milliseconds 250
}
if ($alive) {
    if ($hwnd -ne [IntPtr]::Zero) {
        Write-Host ("[ok]   窗口已创建（hwnd=0x{0:X}，标题「{1}」）" -f [int64]$hwnd, $proc.MainWindowTitle) -ForegroundColor Green
    }
    else {
        Write-Host ("[FAIL] 没等到标题匹配的面板窗口（MainWindowTitle=「{0}」）—— 大概率是单实例互斥体把它挡掉了" -f $proc.MainWindowTitle) -ForegroundColor Red
        $alive = $false
    }
}

# ---- 3.5 独立测量（不采信 app 自己的日志） ----
# 本脚本进程被显式设成 PerMonitorV2（见文件开头），所以这里 GetClientRect / GetWindowRect
# 拿到的是**真实物理像素**，可以和 app 日志里的数字对照。
#
# 这一步是必要的：如果测量进程 DPI 不感知，Windows 会把坐标虚拟化 ——
# 一个 757px 宽的客户区会被报成 605.6px，再按 1.25 换算一次就变成 484 DIP，
# 于是出现「app 说客户区 605.6DIP、我量到 484DIP」这种假冲突（已经真的发生过一次）。
if ($alive -and $hwnd -ne [IntPtr]::Zero) {
    $cli = New-Object WsxWin32+RECT
    $frm = New-Object WsxWin32+RECT
    [WsxWin32]::GetClientRect($hwnd, [ref]$cli) | Out-Null
    [WsxWin32]::GetWindowRect($hwnd, [ref]$frm) | Out-Null
    $dpi = [WsxWin32]::GetDpiForWindow($hwnd)
    $sc = if ($dpi -gt 0) { $dpi / 96.0 } else { 1.0 }
    $cw = $cli.Right - $cli.Left; $ch = $cli.Bottom - $cli.Top
    $fw = $frm.Right - $frm.Left; $fh = $frm.Bottom - $frm.Top
    Write-Host ("独立测量(DPI感知进程): dpi={0} scale={1:0.###}" -f $dpi, $sc) -ForegroundColor Cyan
    Write-Host ("        frame  = {0}x{1}px = {2:0.#}x{3:0.#}DIP" -f $fw, $fh, ($fw / $sc), ($fh / $sc)) -ForegroundColor Cyan
    Write-Host ("        client = {0}x{1}px = {2:0.#}x{3:0.#}DIP   <- 布局宽度应当等于这个 DIP 值" -f `
        $cw, $ch, ($cw / $sc), ($ch / $sc)) -ForegroundColor Cyan
    Write-Host ("        （DPI 不感知的进程会把这个 client 看成 {0:0.#}px，再除一次 {1:0.###} 得 {2:0.#} —— 那样就错了两次）" -f `
        ($cw / $sc), $sc, ($cw / $sc / $sc)) -ForegroundColor DarkGray
}

# ---- 4. 截图 ----
if ($Shot -and $alive) {
    [WsxWin32]::ShowWindow($hwnd, 9) | Out-Null      # SW_RESTORE
    [WsxWin32]::SetForegroundWindow($hwnd) | Out-Null
    Start-Sleep -Milliseconds 900                     # 留给合成器一帧

    $rect = Get-VisibleRect -Handle $hwnd
    $w = $rect.Right - $rect.Left
    $h = $rect.Bottom - $rect.Top

    # 自检：DPI 感知生效时，物理像素尺寸应当约等于 DIP * 缩放比例。
    # 如果这里明显偏小，说明感知没设上，截图会缺一块 —— 宁可直接报出来。
    Write-Host ("窗口物理矩形 {0}x{1} @ ({2},{3})；请求的 DIP 尺寸 {4}x{5}" -f `
        $w, $h, $rect.Left, $rect.Top, $Width, $Height) -ForegroundColor DarkGray

    $bmp = New-Object System.Drawing.Bitmap($w, $h)
    try {
        $g = [System.Drawing.Graphics]::FromImage($bmp)
        try {
            $g.CopyFromScreen($rect.Left, $rect.Top, 0, 0, (New-Object System.Drawing.Size($w, $h)))
        }
        finally { $g.Dispose() }

        # 相对路径按**插件根目录**解析，而不是当前工作目录：
        # 否则从别处调用（比如从 DSH 会话根跑）截图会落到仓库外面去。
        $shotFull = if ([System.IO.Path]::IsPathRooted($Shot)) {
            [System.IO.Path]::GetFullPath($Shot)
        }
        else {
            [System.IO.Path]::GetFullPath((Join-Path (Split-Path $PSScriptRoot -Parent) $Shot))
        }
        New-Item -ItemType Directory -Force -Path ([System.IO.Path]::GetDirectoryName($shotFull)) | Out-Null
        $bmp.Save($shotFull, [System.Drawing.Imaging.ImageFormat]::Png)
        Write-Host ("[ok]   截图 {0}（{1}x{2} 物理像素）" -f $shotFull, $w, $h) -ForegroundColor Green
    }
    finally { $bmp.Dispose() }
}

# ---- 5. 收尾 ----
if ($GracefulClose -and -not $proc.HasExited) {
    # 发 WM_CLOSE 走正常关闭路径（OnClosed 里保存位置/设置），再等它自己退。
    Write-Host '发送 WM_CLOSE（走 OnClosed 保存路径）…' -ForegroundColor Cyan
    $proc.CloseMainWindow() | Out-Null
    if ($proc.WaitForExit(8000)) {
        Write-Host ("[ok]   窗口正常关闭，ExitCode={0}" -f $proc.ExitCode) -ForegroundColor Green
    }
    else {
        Write-Host '[FAIL] 8s 内没有正常退出，只能强杀' -ForegroundColor Red
        Stop-Process -Id $proc.Id -Force
        $alive = $false
    }

    foreach ($candidate in @((Join-Path $env:LOCALAPPDATA 'DshWsxPanel\window.json'),
                             (Join-Path (Split-Path $Exe -Parent) 'window.json'))) {
        if (Test-Path $candidate) {
            $info = Get-Item $candidate
            Write-Host ("        位置记忆：{0}（{1} 字节，{2}）" -f $candidate, $info.Length, $info.LastWriteTime) -ForegroundColor DarkGray
            Write-Host ("        {0}" -f ((Get-Content $candidate -Raw).Trim() -replace "`r?`n", ' ')) -ForegroundColor DarkGray
        }
    }
}
elseif (-not $KeepRunning -and -not $proc.HasExited) {
    Stop-Process -Id $proc.Id -Force
    Start-Sleep -Milliseconds 400
    Write-Host '[ok]   已强制结束进程' -ForegroundColor DarkGray
}

if (Test-Path $logPath) {
    $lines = Get-Content $logPath
    if ($lines.Count -gt $logBefore) {
        Write-Host '--- 本次运行新增的 panel.log ---' -ForegroundColor DarkGray
        $lines[$logBefore..($lines.Count - 1)] | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }
    }
}

if (-not $alive) { exit 1 }
exit 0
