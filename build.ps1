# 构建 DSH 远程目标面板（WinUI 3 窗口）
#
#   .\build.ps1            # 常规 Release 构建（开发用，输出在 app\bin\...）
#   .\build.ps1 -Pack      # 发布到仓库根的 dist\ —— 宿主插件默认按这个路径找 exe
#   .\build.ps1 -Clean     # 先清 bin/obj/dist
#
# 说明：
#   * 本机没有 Visual Studio、也没有 MSBuild 在 PATH 上，只用 .NET SDK 就能构建。
#     关键是 csproj 里的 EnableMsixTooling=true：它决定用哪套 PRI 工具链。
#     设为 false 会回落到 MrtCore.PriGen.targets，那需要 Visual Studio 才有的
#     Microsoft.Build.Packaging.Pri.Tasks.dll，必定报 MSB4062（ExpandPriContent）。
#   * Windows App SDK 采用 self-contained 模式：最终 exe 不依赖预装的
#     Windows App Runtime，也不需要 MSIX 打包，拷到同架构 Windows 上就能跑。
#     代价是 dist\ 会带上完整的 .NET + WinAppSDK 运行时（约 170MB / 380+ 文件）。
#   * 发布目录会被裁掉 .pdb（调试符号，随包发布没意义）。

param(
    [switch]$Pack,
    [switch]$Clean,
    # 跳过代码签名。签名需要一个当前用户的自签名代码签名证书（见 sign-panel.ps1）；
    # 没装证书时 sign-panel.ps1 会幂等地装上它。
    [switch]$SkipSign
)

$ErrorActionPreference = 'Stop'

# 优先用本机安装的 .NET SDK；找不到就退回 PATH 上的 dotnet。
$dotnet = Join-Path $env:ProgramFiles 'dotnet\dotnet.exe'
if (-not (Test-Path $dotnet)) { $dotnet = 'dotnet' }

$root = $PSScriptRoot
$appDir = Join-Path $root 'app'
$distDir = Join-Path $root 'dist'
$exeName = 'WsxPanel.exe'

if (-not (Test-Path $appDir)) { throw "找不到 app 目录：$appDir" }

# ---------------------------------------------------------------------------
# 保住面板记住的窗口位置/设置。
#
# 为什么需要这一步：面板进程实测**只能往工作区内、exe 旁边**写设置
# （%LOCALAPPDATA% 与 %TEMP% 的写入都被拒，见 app\WindowPlacement.cs 的注释），
# 所以它的 window.json 就落在 dist\ 里。而下面 -Clean 与 -Pack 都会把整个
# dist\ 删掉重建 —— 不备份的话，每次重新构建都会把用户拖好的窗口大小、
# 置顶/精简/主题全部重置，表现为「设置老是记不住」。
#
# 备份到构建暂存目录，发布完成后再放回去。
# ---------------------------------------------------------------------------
$settingsBackup = Join-Path $env:TEMP 'dsh-remote-panel-window.json.bak'
$settingsFile = Join-Path $distDir 'window.json'
$hadSettings = $false
if (Test-Path $settingsFile) {
    try {
        Copy-Item $settingsFile $settingsBackup -Force
        $hadSettings = $true
        Write-Host '已备份面板窗口设置（window.json）' -ForegroundColor DarkGray
    }
    catch {
        Write-Warning "备份 dist\window.json 失败：$($_.Exception.Message)"
    }
}

if ($Clean) {
    Write-Host '清理 bin/obj/dist …' -ForegroundColor Cyan
    foreach ($dir in @((Join-Path $appDir 'bin'), (Join-Path $appDir 'obj'), $distDir)) {
        if (Test-Path $dir) { Remove-Item $dir -Recurse -Force }
    }
}

Push-Location $appDir
try {
    if ($Pack) {
        Write-Host '发布（self-contained, win-x64）-> dist\' -ForegroundColor Cyan
        # 关键：**绝不先删 dist\**。
        #
        # 踩过一次很贵的坑：这里原本是 `Remove-Item $distDir -Recurse -Force` 再发布。
        # 但宿主插件是**按定时器拉起面板**的（`--exit-after-stale 90`），删目录那几十秒里
        # dist\WsxPanel.exe 不存在，插件每次都拉起失败 —— 用户看到的是「面板疯狂重启/打不开」，
        # 而且连 window.json 一起被删掉，设置也回到默认。
        #
        # 改成原地覆盖发布：dotnet publish 会把文件逐个写过去，exe 只在自身被复制的那一瞬间
        # 处于「正在写入」，不存在「整个 exe 消失几十秒」的窗口。顺带 window.json 也不会再被删。
        # 只有在 exe 真被占用（面板正在跑）时才需要先结束进程，那也只是一次几毫秒的复制间隙。
        & $dotnet publish -c Release -r win-x64 --self-contained true -o $distDir -v minimal
        if ($LASTEXITCODE -ne 0) { throw "dotnet publish 退出码 $LASTEXITCODE" }
    }
    else {
        Write-Host '构建（Release）…' -ForegroundColor Cyan
        & $dotnet build -c Release -v minimal
        if ($LASTEXITCODE -ne 0) { throw "dotnet build 退出码 $LASTEXITCODE" }
    }
}
finally {
    Pop-Location
}

if ($Pack) {
    # 调试符号不随包发布（保留也无用，还多占体积）。
    $pdbs = @(Get-ChildItem $distDir -Filter '*.pdb' -Recurse -File -ErrorAction SilentlyContinue)
    if ($pdbs.Count -gt 0) {
        $freed = ($pdbs | Measure-Object Length -Sum).Sum
        $pdbs | Remove-Item -Force
        Write-Host ("已裁掉 {0} 个 .pdb（{1:N0} 字节）" -f $pdbs.Count, $freed) -ForegroundColor DarkGray
    }

    # 裁掉用不到的本地化卫星目录。
    #
    # 为什么在这里做而不是 csproj 的 SatelliteResourceLanguages：
    #   那 76 个语言目录**不是** .NET 卫星程序集，而是 WindowsAppSDK / WinUI
    #   NuGet 包按 Content 拷进来的 mui 资源，所以 SatelliteResourceLanguages
    #   对它们不起作用（实测设了仍是 76 个目录、体积一点没变）。
    #   只能在发布后按目录名删。
    #
    # 保留 en-us（WinUI 内置控件的英文兜底）与 zh-CN（中文系统的内置控件文案；
    # 本插件界面本身是中文，删掉会让 Flyout/ComboBox 之类退回英文，中英混排）。
    # 想支持别的语言，把它加进下面的 $keepLocales。
    $keepLocales = @('en-us', 'zh-CN')
    $localeDirs = @(Get-ChildItem $distDir -Directory -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -match '^[a-z]{2,3}(-[A-Za-z0-9]{2,4})*$' -and $keepLocales -notcontains $_.Name })
    if ($localeDirs.Count -gt 0) {
        $freed = 0
        foreach ($d in $localeDirs) {
            $freed += (Get-ChildItem $d.FullName -Recurse -File -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum
            Remove-Item $d.FullName -Recurse -Force -ErrorAction SilentlyContinue
        }
        Write-Host ("已裁掉 {0} 个本地化目录（{1:N0} 字节），保留 {2}" -f $localeDirs.Count, $freed, ($keepLocales -join ', ')) -ForegroundColor DarkGray
    }

    # exe 旁边的 app.ico 是必须的：窗口启动时用它调 AppWindow.SetIcon 兜底。
    if (-not (Test-Path (Join-Path $distDir 'app.ico'))) {
        Write-Warning 'dist\ 里没有 app.ico —— 任务栏图标会回落到 exe 内嵌图标。'
    }

    $exe = Join-Path $distDir $exeName
    if (-not (Test-Path $exe)) { throw "发布成功但没找到 $exe" }

    $files = @(Get-ChildItem $distDir -Recurse -File)
    $sizeMb = [math]::Round((($files | Measure-Object Length -Sum).Sum) / 1MB, 1)
    Write-Host "`n打包完成：$exe" -ForegroundColor Green
    Write-Host ("  {0} 个文件，{1} MB" -f $files.Count, $sizeMb) -ForegroundColor Green

    # 签名。不签名的话每次启动 Windows 都会弹「无法验证发布者」的安全警告。
    # 证书是当前用户的自签名代码签名证书（见 sign-panel.ps1），**不是**商业证书，
    # 所以只对本机当前用户消除警告。用 -SkipSign 可跳过。
    if (-not $SkipSign) {
        Write-Host "`n代码签名…" -ForegroundColor Cyan
        & pwsh -NoProfile -File (Join-Path $root 'sign-panel.ps1') -ExePath $exe
        if ($LASTEXITCODE -ne 0) {
            Write-Warning '签名失败 —— exe 仍可用，但每次启动会有「无法验证发布者」提示。'
        }
    }

    # 发布完立刻做一次无界面自检，确认这个 exe 真的能起来（而不是只有文件躺在那里）。
    Write-Host "`n无界面自检（--dump-status）…" -ForegroundColor Cyan
    & pwsh -NoProfile -File (Join-Path $root 'test\run-checks.ps1') -Exe $exe
    if ($LASTEXITCODE -ne 0) { throw "自检失败：test\run-checks.ps1 退出码 $LASTEXITCODE" }
}
else {
    $exe = Join-Path $appDir 'bin\Release\net8.0-windows10.0.19041.0\win-x64\WsxPanel.exe'
    if (Test-Path $exe) { Write-Host "`n构建完成：$exe" -ForegroundColor Green }
    else { Write-Warning "构建似乎成功，但没找到预期的 exe：$exe" }
}
