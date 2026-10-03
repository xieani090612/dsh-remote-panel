<#
.SYNOPSIS
    把 dsh-remote-panel 安装进一个 DSH profile。

.DESCRIPTION
    这是一个 DSH bundle 包。安装动作本身很简单（把包登记进 profile 的依赖与
    bundle 列表），但有几件事容易踩坑，所以脚本把它们都替你做了：

      1. 校验包结构（lib/ bin/ scripts/ 都在，否则装上也跑不起来）；
      2. 把技能拷进 `$DSH_HOME\skills\` —— 这是 DSH 的**默认技能扫描根**，
         不需要任何配置就能被智能体发现；
      3. 用 `dsh plugin add` **或**直接写 profile 的 package.json（两条路都支持，
         取决于你机器上有没有 dsh 命令行）；
      4. 备份 profile 的 package.json，改坏了好回滚；
      5. 提示你重启 DSH（bundle 变更必须重启才生效）。

.PARAMETER Profile
    profile 名字。默认 `desktop`。

.PARAMETER DshHome
    DSH 主目录。默认取 $env:DSH_HOME，没有就 `~\.dsh`。

.PARAMETER NoSkills
    跳过把技能拷进 $DSH_HOME\skills。

.PARAMETER Uninstall
    反向操作：从 profile 移除本 bundle，并删掉拷进去的技能。

.EXAMPLE
    pwsh -File .\install.ps1
    pwsh -File .\install.ps1 -Profile desktop
    pwsh -File .\install.ps1 -Uninstall
#>
[CmdletBinding()]
param(
    [string]$Profile = 'desktop',
    [string]$DshHome,
    [switch]$NoSkills,
    [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$PackageName = 'dsh-remote-panel'
$Root = $PSScriptRoot
$SkillNames = @('remote-panel', 'remote-panel-troubleshooting')

if (-not $DshHome) {
    $DshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
}
$ProfileDir = Join-Path $DshHome "profiles\$Profile"
$ProfileJson = Join-Path $ProfileDir 'package.json'
$SkillsRoot = Join-Path $DshHome 'skills'

function Step($t) { Write-Host "==> $t" -ForegroundColor Cyan }
function Ok($t) { Write-Host "    $t" -ForegroundColor Green }
function Warn($t) { Write-Host "    $t" -ForegroundColor Yellow }
function Die($t) { Write-Host "    $t" -ForegroundColor Red; exit 1 }

# ---------------------------------------------------------------------------
Step "检查包结构"
# ---------------------------------------------------------------------------
foreach ($required in @('package.json', 'cordis.patch.yml', 'lib\index.js', 'lib\client.js', 'bin\mcp-server.js', 'scripts\probe.sh')) {
    if (-not (Test-Path (Join-Path $Root $required))) {
        Die "包里缺少 $required —— 安装包不完整。请重新解压完整的发行包。"
    }
}
$manifest = Get-Content (Join-Path $Root 'package.json') -Raw | ConvertFrom-Json
Ok "包 $($manifest.name)@$($manifest.version)"

$hasPanel = Test-Path (Join-Path $Root 'dist\WsxPanel.exe')
if ($hasPanel) { Ok "自带 WinUI 3 面板（dist\WsxPanel.exe），不需要自己构建" }
else { Warn "没有 dist\WsxPanel.exe —— 面板窗口需要你先跑 .\build.ps1 -Pack（要 .NET 8 SDK）。/wsx 与 remote_* 工具不受影响。" }

# ---------------------------------------------------------------------------
if ($Uninstall) {
    Step "卸载"
    if (-not (Test-Path $ProfileJson)) { Die "找不到 profile：$ProfileJson" }

    Copy-Item $ProfileJson "$ProfileJson.bak" -Force
    $profile = Get-Content $ProfileJson -Raw | ConvertFrom-Json
    if ($profile.dependencies.PSObject.Properties.Name -contains $PackageName) {
        $profile.dependencies.PSObject.Properties.Remove($PackageName)
    }
    if ($profile.dsh.profile.bundles -contains $PackageName) {
        $profile.dsh.profile.bundles = @($profile.dsh.profile.bundles | Where-Object { $_ -ne $PackageName })
    }
    $profile | ConvertTo-Json -Depth 10 | Set-Content $ProfileJson -Encoding UTF8
    Ok "已从 $ProfileJson 移除 $PackageName（原文件备份为 package.json.bak）"

    foreach ($s in $SkillNames) {
        $p = Join-Path $SkillsRoot $s
        if (Test-Path $p) { Remove-Item $p -Recurse -Force; Ok "已删除技能 $s" }
    }
    Write-Host ''
    Write-Host '卸载完成。重启 DSH 后生效。' -ForegroundColor Yellow
    return
}

# ---------------------------------------------------------------------------
Step "把技能装进默认扫描根"
# ---------------------------------------------------------------------------
if ($NoSkills) { Warn '已按 -NoSkills 跳过' }
else {
    New-Item -ItemType Directory -Force -Path $SkillsRoot | Out-Null
    foreach ($s in $SkillNames) {
        $src = Join-Path $Root "skills\$s"
        if (-not (Test-Path $src)) { Warn "包里没有 skills\$s，跳过"; continue }
        $dst = Join-Path $SkillsRoot $s
        New-Item -ItemType Directory -Force -Path $dst | Out-Null
        Copy-Item "$src\*" $dst -Recurse -Force
        Ok "$s -> $dst"
    }
    Write-Host '    （技能目录带监视，装完即可用，不必重启）' -ForegroundColor DarkGray
}

# ---------------------------------------------------------------------------
Step "登记到 profile「$Profile」"
# ---------------------------------------------------------------------------
if (-not (Test-Path $ProfileDir)) {
    Die "找不到 profile 目录：$ProfileDir`n请先启动一次 DSH 让它创建该 profile，或用 -Profile 指定别的名字。"
}

$dshCmd = Get-Command dsh -ErrorAction SilentlyContinue
if ($dshCmd) {
    Ok "发现 dsh 命令行，用它安装"
    & dsh plugin --profile $Profile add $Root
    if ($LASTEXITCODE -ne 0) { Die "dsh plugin add 失败（退出码 $LASTEXITCODE）" }
}
else {
    Warn '没有 dsh 命令行 —— 改为直接写 profile 的 package.json'
    Copy-Item $ProfileJson "$ProfileJson.bak" -Force
    $profile = Get-Content $ProfileJson -Raw | ConvertFrom-Json

    # dependencies：用 link: 指向本目录，这样改包里的文件不用重装
    $linkSpec = 'link:' + ($Root -replace '\\', '/')
    if ($profile.dependencies.PSObject.Properties.Name -contains $PackageName) {
        $profile.dependencies.$PackageName = $linkSpec
    }
    else {
        $profile.dependencies | Add-Member -NotePropertyName $PackageName -NotePropertyValue $linkSpec
    }

    # bundles：追加到末尾（顺序=层栈顺序，本插件不依赖别的插件，放最后即可）
    if ($profile.dsh.profile.bundles -notcontains $PackageName) {
        $profile.dsh.profile.bundles = @($profile.dsh.profile.bundles) + $PackageName
    }

    $profile | ConvertTo-Json -Depth 10 | Set-Content $ProfileJson -Encoding UTF8
    Ok "已写入 $ProfileJson（原文件备份为 package.json.bak）"

    Write-Host '    现在跑一次依赖安装…' -ForegroundColor DarkGray
    Push-Location $ProfileDir
    try {
        if (Get-Command pnpm -ErrorAction SilentlyContinue) { & pnpm install }
        elseif (Get-Command npm -ErrorAction SilentlyContinue) { & npm install }
        else { Warn '没找到 pnpm/npm —— 请手动在 profile 目录里执行一次依赖安装' }
    }
    finally { Pop-Location }
}

Write-Host ''
Write-Host '安装完成。' -ForegroundColor Green
Write-Host ''
Write-Host '最后一步：**重启 DSH**（bundle 变更必须重启才加载）。' -ForegroundColor Yellow
Write-Host '重启后在会话里试：' -ForegroundColor DarkGray
Write-Host '  /wsx list          列出目标与工具注册路径' -ForegroundColor DarkGray
Write-Host '  /wsx               状态总览' -ForegroundColor DarkGray
Write-Host '  /wsx panel         打开 WinUI 3 悬浮窗' -ForegroundColor DarkGray
Write-Host ''
Write-Host '记得按需要编辑 profile 的 cordis.patch.yml，把 config.targets 里的' -ForegroundColor DarkGray
Write-Host '示例目标改成你自己的机器（见 README 的「配置目标」一节）。' -ForegroundColor DarkGray
