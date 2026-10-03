<#
.SYNOPSIS
    打出可分发的 dsh-remote-panel 发行包，并算好 SHA256。

.DESCRIPTION
    产出两样东西（都在仓库根的 `release\` 下）：

      dsh-remote-panel-<版本>.zip
          给「下载解压、然后跑 install.ps1」的使用者。内含预编译的
          WinUI 3 面板（dist\），所以**不需要装 .NET SDK**。

      dsh-remote-panel-<版本>.tgz
          给「用插件管理器 / pnpm 直接装包」的使用者
          （`dsh plugin add file:<tgz>`）。内容由 package.json 的 `files` 决定。

    同时打印一份发布检查单，并把体积如实报出来 —— dist\ 是 self-contained 的
    .NET + Windows App SDK 运行时，约 160 MB，这是「目标机器什么都不用装」的代价。

.PARAMETER SkipBuild
    不重新构建面板，直接用现有的 dist\。想省下那 ~90 秒构建时间时用。
    注意：跳过构建意味着 dist\ 可能是旧的，脚本会警告。

.PARAMETER OutDir
    输出目录，默认 <仓库根>\release。

.EXAMPLE
    pwsh -File .\release.ps1
    pwsh -File .\release.ps1 -SkipBuild
#>
[CmdletBinding()]
param(
    [switch]$SkipBuild,
    [string]$OutDir
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$Root = $PSScriptRoot
if (-not $OutDir) { $OutDir = Join-Path $Root 'release' }

function Step($t) { Write-Host "==> $t" -ForegroundColor Cyan }
function Ok($t) { Write-Host "    $t" -ForegroundColor Green }
function Warn($t) { Write-Host "    $t" -ForegroundColor Yellow }

# ---------------------------------------------------------------------------
Step "读取版本号"
# ---------------------------------------------------------------------------
$manifest = Get-Content (Join-Path $Root 'package.json') -Raw | ConvertFrom-Json
$version = $manifest.version
$name = $manifest.name
Ok "$name@$version"

# ---------------------------------------------------------------------------
Step "发布前自检（防止把个人数据带进发行包）"
# ---------------------------------------------------------------------------
# 这条检查是硬性的：包里出现任何本机用户名/机器名/绝对家目录路径，
# 都会让「发布」变成一次隐私事故。
$sourceFiles = @(Get-ChildItem $Root -Recurse -File -Force -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -notmatch '\\dist\\|\\app\\obj\\|\\app\\bin\\|\\release\\|\\test\\markdown' -and
                   $_.Extension -in '.js','.mjs','.json','.yml','.yaml','.md','.ps1','.sh','.cs','.xaml','.csproj','.py','.manifest','.txt' })

$leakPatterns = @{
    'Windows 用户目录绝对路径' = 'C:[\\/]+Users[\\/]+(?!<|\$|%|path|you|your|User\b|username)[A-Za-z0-9._-]+'
    # 只认**具体的**家目录名。`/home/dev`、`/home/user`、`/home/example` 这类是
    # 测试夹具里常见的占位名，不是隐私；排除它们，否则检查会对着自己的测试数据
    # 反复误报（实测踩到：run-checks.ps1 里一条 `node /home/dev/app/server.js`
    # 的示例进程把整次发布拦下来了）。
    'posix 家目录绝对路径'     = '/home/(?!(?:dev|user|users|test|example|sample|foo|bar|baz|app|me|you|username|youruser)\b)[a-z][a-z0-9_-]{2,}'
    # 这两个是「本机专有字符串」。刻意用字符码拼出来，而不是直接写字面量：
    # 否则 release.ps1 自己就会包含那个字符串，被自己的检查命中（自指问题），
    # 而且一旦这个脚本随包发布，就等于把维护者的用户名印在包里。
    '本机用户名'               = ([char]0x78 + [char]0x61 + [char]0x71 + '18')
    '本机机器名'               = ('DESKTOP' + '-' + [char]0x45 + '07' + [char]0x49 + [char]0x45 + '3H')
    'GitHub token'             = 'gh[pousr]_[A-Za-z0-9]{20,}'
    'OpenAI 风格密钥'          = 'sk-[A-Za-z0-9]{20,}'
    '私钥头'                   = '-----BEGIN [A-Z ]*PRIVATE KEY'
}
$leaks = @()
foreach ($label in $leakPatterns.Keys) {
    $hits = $sourceFiles | Select-String -Pattern $leakPatterns[$label] -ErrorAction SilentlyContinue
    foreach ($h in $hits) {
        $leaks += "  [$label] $($h.Path.Substring($Root.Length + 1)):$($h.LineNumber) :: $($h.Line.Trim())"
    }
}
if ($leaks.Count -gt 0) {
    Write-Host '发现疑似个人数据 / 凭据，已中止发布：' -ForegroundColor Red
    $leaks | ForEach-Object { Write-Host $_ -ForegroundColor Red }
    throw "发布中止：先清理上面这些内容。"
}
Ok "未发现个人数据或凭据（检查了 $($sourceFiles.Count) 个源文件）"

# ---------------------------------------------------------------------------
Step "准备输出目录"
# ---------------------------------------------------------------------------
if (Test-Path $OutDir) { Remove-Item $OutDir -Recurse -Force }
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
Ok $OutDir

# ---------------------------------------------------------------------------
Step "构建面板（self-contained）"
# ---------------------------------------------------------------------------
$distExe = Join-Path $Root 'dist\WsxPanel.exe'
if ($SkipBuild) {
    if (Test-Path $distExe) {
        $age = (Get-Date) - (Get-Item $distExe).LastWriteTime
        Warn "-SkipBuild：沿用现有 dist\（构建于 $([int]$age.TotalMinutes) 分钟前）"
        if ($age.TotalHours -gt 24) { Warn "⚠ 这份 dist\ 已经超过 24 小时，可能不是当前源码构建的" }
    } else {
        throw "-SkipBuild 但 dist\WsxPanel.exe 不存在，无法打包。"
    }
} else {
    & pwsh -NoProfile -File (Join-Path $Root 'build.ps1') -Pack
    if ($LASTEXITCODE -ne 0) { throw "build.ps1 -Pack 退出码 $LASTEXITCODE" }
}

# ---------------------------------------------------------------------------
Step "打 zip（给别人解压安装用）"
# ---------------------------------------------------------------------------
# 只挑使用者真正需要的东西：不带 app\ 源码、不带 test\、不带 release\ 本身。
$stage = Join-Path $env:TEMP "dsh-remote-panel-stage-$version"
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory -Force -Path $stage | Out-Null

$include = @('lib', 'bin', 'scripts', 'skills', 'dist', 'docs', 'locale',
             'package.json', 'cordis.patch.yml', 'install.ps1', 'build.ps1',
             'sign-panel.ps1', 'README.md', 'INSTALL.md', 'CHANGELOG.md', 'LICENSE', '.gitignore')
foreach ($item in $include) {
    $src = Join-Path $Root $item
    if (-not (Test-Path $src)) { Warn "跳过不存在的 $item"; continue }
    Copy-Item $src -Destination $stage -Recurse -Force
}
# 不要把「使用者本机的窗口设置」和日志打进发行包
foreach ($junk in @('window.json', 'WsxPanel.log', 'panel.log')) {
    Get-ChildItem $stage -Recurse -File -Filter $junk -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
}

$zip = Join-Path $OutDir "$name-$version.zip"
Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $zip -CompressionLevel Optimal
Remove-Item $stage -Recurse -Force
Ok "$([math]::Round((Get-Item $zip).Length / 1MB, 1)) MB  ->  $zip"

# ---------------------------------------------------------------------------
Step "打 tgz（给插件管理器 / pnpm 用）"
# ---------------------------------------------------------------------------
# 注意：这里必须用**绝对路径**的 node。
# 踩过：`Get-Command node` 在只装了 DSH 自带运行时、没把 node 加进 PATH 的机器上
# 返回空，于是整段以「术语 'node' 不是 cmdlet」失败，tgz 静默没生成。
$nodeExe = $null
foreach ($candidate in @(
        (Join-Path $env:USERPROFILE '.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'),
        (Join-Path $env:ProgramFiles 'nodejs\node.exe')
    )) {
    if (Test-Path $candidate) { $nodeExe = $candidate; break }
}
if (-not $nodeExe) {
    $cmd = Get-Command node -ErrorAction SilentlyContinue
    if ($cmd) { $nodeExe = $cmd.Source }
}
$pnpmMjs = Join-Path $env:USERPROFILE '.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.mjs'
$tgz = $null

if ($nodeExe -and (Test-Path $pnpmMjs)) {
    Push-Location $Root
    try {
        $packed = & $nodeExe $pnpmMjs pack --pack-destination $OutDir 2>&1
        $tgzLine = $packed | Where-Object { $_ -match '\.tgz$' } | Select-Object -Last 1
        if ($tgzLine) { $tgz = Join-Path $OutDir (Split-Path $tgzLine -Leaf) }
        else { Warn "pnpm pack 没输出 tgz 路径：$($packed | Select-Object -Last 2)" }
    } finally { Pop-Location }
} elseif ($nodeExe) {
    Push-Location $Root
    try {
        $packed = & $nodeExe (Join-Path (Split-Path $nodeExe -Parent) 'node_modules\npm\bin\npm-cli.js') pack --pack-destination $OutDir 2>&1
        $tgzLine = $packed | Where-Object { $_ -match '\.tgz$' } | Select-Object -Last 1
        if ($tgzLine) { $tgz = Join-Path $OutDir (Split-Path $tgzLine -Leaf) }
    } finally { Pop-Location }
} else {
    Warn "找不到 node（DSH 自带运行时和系统 nodejs 都没有）—— 跳过 tgz"
}

if ($tgz -and (Test-Path $tgz)) { Ok "$([math]::Round((Get-Item $tgz).Length / 1MB, 1)) MB  ->  $tgz" }
else { Warn "没能生成 tgz —— zip 依然可用，使用者可以解压后跑 install.ps1" }

# ---------------------------------------------------------------------------
Step "算 SHA256"
# ---------------------------------------------------------------------------
foreach ($f in @($zip, $tgz) | Where-Object { $_ -and (Test-Path $_) }) {
    $hash = (Get-FileHash $f -Algorithm SHA256).Hash.ToLower()
    $line = "$hash  $(Split-Path $f -Leaf)"
    Set-Content "$f.sha256" $line -Encoding ASCII
    Ok $line
}

# ---------------------------------------------------------------------------
Write-Host ''
Write-Host '发布完成。产物：' -ForegroundColor Green
Get-ChildItem $OutDir | ForEach-Object { Write-Host ("  {0,-46} {1,8:N1} MB" -f $_.Name, ($_.Length / 1MB)) -ForegroundColor Green }
Write-Host ''
Write-Host '发布检查单（建议逐条确认）：' -ForegroundColor Cyan
Write-Host '  [ ] README / INSTALL 与实际行为一致（尤其配置默认值）' -ForegroundColor DarkGray
Write-Host '  [ ] 隐私自检通过（本脚本已自动检查源文件）' -ForegroundColor DarkGray
Write-Host '  [ ] node test\run-all.mjs 全绿' -ForegroundColor DarkGray
Write-Host '  [ ] dist\ 是这次重新构建的（没加 -SkipBuild 就满足）' -ForegroundColor DarkGray
Write-Host '  [ ] 在干净机器上试一次「解压 -> install.ps1 -> 重启 DSH -> /wsx」' -ForegroundColor DarkGray
Write-Host '  [ ] 面板 exe 未签名会让 Windows 提示「未知发布者」—— 已在 README 说明' -ForegroundColor DarkGray
Write-Host '  [ ] 仓库 About 填了描述与 topics（dsh-plugin / deepseek-harness / winui3 / mcp）' -ForegroundColor DarkGray
Write-Host ''
Write-Host '提醒：dist\ 是 self-contained 的 .NET + WinAppSDK 运行时（约 160 MB），' -ForegroundColor DarkGray
Write-Host '      这是「目标机器不需要装 .NET / WindowsAppRuntime / MSIX」的代价。' -ForegroundColor DarkGray
Write-Host '      想发小包就别带 dist\，让使用者自己 dotnet build —— 见 README。' -ForegroundColor DarkGray
