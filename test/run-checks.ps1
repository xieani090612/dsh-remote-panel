# 生成测试用的状态文件（真实形状，不是最小骨架），并逐项断言 --dump-status 的输出。
#
#   .\test\run-checks.ps1                 # 用 app\bin 里的开发构建
#   .\test\run-checks.ps1 -Exe <path>     # 指定 exe（比如 dist\WsxPanel.exe）
#
# --dump-status 是一条**无界面**路径：它不开窗口、不初始化 WinUI，只读一次状态文件
# 并打印「状态栏那一行」。它和窗口走的是同一个 StateFileReader + StatusText，
# 所以这里断言到的文本就是状态栏会显示的文本。
#
# 退出码约定：0=正常 2=文件不存在 3=解析/结构错 4=读取失败

param(
    [string]$Exe,
    [string]$WorkDir = (Join-Path $env:TEMP 'wsxpanel-checks')
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
if (-not $Exe) {
    $Exe = Join-Path $root 'app\bin\Release\net8.0-windows10.0.19041.0\win-x64\WsxPanel.exe'
}
if (-not (Test-Path $Exe)) { throw "找不到 exe：$Exe（先跑 .\build.ps1）" }

New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null

$script:pass = 0
$script:fail = 0

function Assert-True {
    param([string]$Name, [bool]$Condition, [string]$Detail = '')
    if ($Condition) {
        $script:pass++
        Write-Host ("  [ok]   {0}" -f $Name) -ForegroundColor DarkGreen
    }
    else {
        $script:fail++
        Write-Host ("  [FAIL] {0}" -f $Name) -ForegroundColor Red
        if ($Detail) { Write-Host ("         {0}" -f $Detail) -ForegroundColor DarkRed }
    }
}

function Invoke-Dump {
    param([string]$StatePath, [int]$StaleSeconds = 15)
    # 走 ProcessStartInfo 而不是 `& $Exe ... | Out-String`：WsxPanel.exe 是 WinExe
    # （GUI 子系统），它往 stdout 写的是 UTF-8 字节，而 PowerShell 默认按控制台代码页
    # 解码，中文会变成乱码、断言永远匹配不上。这里显式按 UTF-8 解码。
    $psi = [System.Diagnostics.ProcessStartInfo]::new()
    $psi.FileName = $Exe
    $psi.ArgumentList.Add('--state')
    $psi.ArgumentList.Add($StatePath)
    $psi.ArgumentList.Add('--stale-seconds')
    $psi.ArgumentList.Add([string]$StaleSeconds)
    $psi.ArgumentList.Add('--dump-status')
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.StandardOutputEncoding = [System.Text.Encoding]::UTF8
    $psi.StandardErrorEncoding = [System.Text.Encoding]::UTF8
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true

    $proc = [System.Diagnostics.Process]::Start($psi)
    $text = $proc.StandardOutput.ReadToEnd() + $proc.StandardError.ReadToEnd()
    $proc.WaitForExit()
    $code = $proc.ExitCode
    $proc.Dispose()

    $map = @{}
    foreach ($line in ($text -split "`r?`n")) {
        $i = $line.IndexOf('=')
        if ($i -gt 0) { $map[$line.Substring(0, $i)] = $line.Substring($i + 1) }
    }
    return [pscustomobject]@{ ExitCode = $code; Text = $text; Map = $map }
}

function NowMs { [long][DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }
function GiB([double]$g) { [long]($g * 1024 * 1024 * 1024) }

# ---------------------------------------------------------------------------
# 1. 真实形状的快照：一个带全套指标的 WSL、一个在线 SSH、一个离线 SSH
# ---------------------------------------------------------------------------
function New-GoodState {
    $now = NowMs
    $stateFile = Join-Path $WorkDir 'state-good.json'

    $snapshot = [ordered]@{
        schema      = 1
        generatedAt = $now
        host        = [ordered]@{
            pid           = 4242
            pluginVersion = '1.0.0'
            stateFile     = $stateFile
            dshHome       = (Join-Path $env:USERPROFILE '.dsh')
            platform      = 'win32'
            startedAt     = $now - 3600000
            revision      = 118
            stopped       = $false
        }
        totals      = [ordered]@{
            targets = 3; online = 2; offline = 1; probing = 0; unknown = 0; dockerRunning = 3
        }
        targets     = @(
            [ordered]@{
                id                  = 'wsl-ubuntu'
                name                = 'Ubuntu 22.04（开发机）'
                kind                = 'wsl'
                host                = 'Ubuntu-22.04'
                tags                = @('dev', 'local')
                enabled             = $true
                status              = 'online'
                latencyMs           = 412
                lastProbeAt         = $now - 3200
                lastOnlineAt        = $now - 3200
                nextProbeAt         = $now + 27000
                consecutiveFailures = 0
                woke                = $true
                facts               = [ordered]@{
                    hostname = 'ubuntu-dev'; os = 'Ubuntu 22.04.4 LTS'
                    kernel   = '5.15.153.1-microsoft-standard-WSL2'; arch = 'x8664'
                    cpuModel = 'AMD Ryzen 9 7950X 16-Core Processor'; cpuCount = 16
                    distro   = 'Ubuntu-22.04'; wsl = $true; uptimeSec = 98400
                }
                metrics             = [ordered]@{
                    cpu     = [ordered]@{ usagePercent = 38.2; load1 = 2.13; load5 = 1.84; load15 = 1.52 }
                    memory  = [ordered]@{
                        totalBytes = (GiB 16); usedBytes = (GiB 5.6); availableBytes = (GiB 10.4)
                        swapTotalBytes = (GiB 4); swapUsedBytes = (GiB 0.3); usagePercent = 35.0
                    }
                    disks   = @(
                        [ordered]@{ mount = '/'; fs = 'ext4'; totalBytes = (GiB 1006); usedBytes = (GiB 688); availableBytes = (GiB 318); usagePercent = 68.4 }
                        [ordered]@{ mount = '/mnt/c'; fs = '9p'; totalBytes = (GiB 1907); usedBytes = (GiB 1740); availableBytes = (GiB 167); usagePercent = 91.2 }
                        [ordered]@{ mount = '/home'; fs = 'ext4'; totalBytes = (GiB 512); usedBytes = (GiB 121); availableBytes = (GiB 391); usagePercent = 23.6 }
                    )
                    gpus    = @(
                        [ordered]@{ index = 0; name = 'NVIDIA GeForce RTX 4090'; utilizationPercent = 87; memoryTotalBytes = (GiB 24); memoryUsedBytes = (GiB 18.2); temperatureC = 62 }
                    )
                    docker  = [ordered]@{
                        available = $true; version = '27.3.1'; containers = 5; running = 3
                        paused = 1; stopped = 1; images = 12
                    }
                    processes = [ordered]@{
                        total  = 412
                        topCpu = @(
                            [ordered]@{ pid = 8421; user = 'dev'; cpuPercent = 142.3; memPercent = 4.1; command = 'node /home/dev/app/server.js' }
                            [ordered]@{ pid = 2290; user = 'dev'; cpuPercent = 61.8; memPercent = 12.7; command = 'code-server --bind-addr 0.0.0.0:8080' }
                            [ordered]@{ pid = 15733; user = 'root'; cpuPercent = 24.5; memPercent = 1.2; command = 'dockerd --host=unix:///var/run/docker.sock' }
                            [ordered]@{ pid = 918; user = 'root'; cpuPercent = 8.1; memPercent = 0.6; command = '/usr/bin/containerd' }
                            [ordered]@{ pid = 31002; user = 'dev'; cpuPercent = 4.4; memPercent = 2.2; command = 'python3 -m pytest -q tests/' }
                        )
                        topMem = @(
                            [ordered]@{ pid = 2290; user = 'dev'; cpuPercent = 61.8; memPercent = 12.7; command = 'code-server --bind-addr 0.0.0.0:8080' }
                        )
                    }
                    services = @(
                        [ordered]@{ name = 'nginx'; active = 'active'; sub = 'running' }
                        [ordered]@{ name = 'docker'; active = 'active'; sub = 'running' }
                        [ordered]@{ name = 'postgresql'; active = 'failed'; sub = 'dead' }
                    )
                }
                history             = @(
                    [ordered]@{ at = $now - 60000; cpuPercent = 22.1; memPercent = 33.0; latencyMs = 380 }
                    [ordered]@{ at = $now - 30000; cpuPercent = 31.7; memPercent = 34.2; latencyMs = 402 }
                    [ordered]@{ at = $now - 3200; cpuPercent = 38.2; memPercent = 35.0; latencyMs = 412 }
                )
            }
            [ordered]@{
                id          = 'ssh-build-01'
                name        = 'build-01'
                kind        = 'ssh'
                host        = '10.20.0.51'
                user        = 'ci'
                port        = 2222
                tags        = @('ci')
                enabled     = $true
                status      = 'online'
                latencyMs   = 88
                lastProbeAt = $now - 1500
                facts       = [ordered]@{
                    hostname = 'build-01'; os = 'Debian GNU/Linux 12 (bookworm)'
                    kernel = '6.1.0-23-amd64'; arch = 'x8664'
                    cpuModel = 'Intel(R) Xeon(R) Silver 4314'; cpuCount = 32
                    uptimeSec = 1204500
                }
                metrics     = [ordered]@{
                    cpu       = [ordered]@{ usagePercent = 71.5; load1 = 18.42; load5 = 16.9; load15 = 14.2 }
                    memory    = [ordered]@{ totalBytes = (GiB 64); usedBytes = (GiB 47.3); usagePercent = 73.9 }
                    disks     = @(
                        [ordered]@{ mount = '/'; fs = 'ext4'; totalBytes = (GiB 96); usedBytes = (GiB 41); usagePercent = 42.7 }
                        [ordered]@{ mount = '/var/lib/docker'; fs = 'xfs'; totalBytes = (GiB 1907); usedBytes = (GiB 1802); usagePercent = 94.5 }
                    )
                    gpus      = @()
                    docker    = [ordered]@{ available = $true; version = '26.1.4'; containers = 11; running = 6; paused = 0; stopped = 5; images = 48 }
                    processes = [ordered]@{
                        total  = 918
                        topCpu = @(
                            [ordered]@{ pid = 4412; user = 'ci'; cpuPercent = 388.0; memPercent = 9.4; command = 'cc1plus -quiet -O2 -o build/obj/large.o src/large.cpp' }
                            [ordered]@{ pid = 4413; user = 'ci'; cpuPercent = 372.6; memPercent = 8.8; command = 'cc1plus -quiet -O2 -o build/obj/other.o src/other.cpp' }
                            [ordered]@{ pid = 5510; user = 'ci'; cpuPercent = 96.2; memPercent = 3.1; command = 'ninja -j32' }
                        )
                    }
                    services  = @([ordered]@{ name = 'docker'; active = 'active'; sub = 'running' })
                }
            }
            [ordered]@{
                id                  = 'ssh-legacy-db'
                name                = 'legacy-db'
                kind                = 'ssh'
                host                = '10.20.0.9'
                user                = 'root'
                port                = 22
                enabled             = $true
                status              = 'offline'
                error               = 'ssh: connect to host 10.20.0.9 port 22: Connection timed out'
                latencyMs           = 20013
                lastProbeAt         = $now - 45000
                lastOnlineAt        = $now - 10800000
                nextProbeAt         = $now + 15000
                consecutiveFailures = 3
                facts               = [ordered]@{ hostname = 'legacy-db'; os = 'CentOS Linux 7 (Core)'; kernel = '3.10.0-1160.el7.x8664'; arch = 'x8664'; cpuCount = 8 }
                metrics             = $null
            }
        )
        errors      = @(
            [ordered]@{
                targetId = 'ssh-legacy-db'; name = 'legacy-db'
                error = 'ssh: connect to host 10.20.0.9 port 22: Connection timed out'
                at = $now - 45000; consecutiveFailures = 3
            }
        )
    }

    # -Depth 要大：metrics/processes 嵌得比较深，截断了就不是「真实形状」了。
    # -EscapeHandling Default 让中文保持可读（PS7.2+）。
    $json = $snapshot | ConvertTo-Json -Depth 16 -EscapeHandling Default
    Set-Content -Path $stateFile -Value $json -Encoding utf8NoBOM
    return $stateFile
}

Write-Host "`n=== 1. 正常路径 ===" -ForegroundColor Cyan
$good = New-GoodState
# 用很大的 stale 阈值：这一节要断言的是「正常渲染」，不该被机器慢/排队导致的
# 「快照刚刚过 15 秒」影响。心跳超时本身在第 8 节里单独测。
$r = Invoke-Dump $good 3600
Assert-True '退出码 0' ($r.ExitCode -eq 0) "实际 $($r.ExitCode)"
Assert-True 'state=live' ($r.Map['state'] -eq 'live') "实际 $($r.Map['state'])"
Assert-True 'targets=3' ($r.Map['targets'] -eq '3') "实际 $($r.Map['targets'])"
Assert-True 'online=2' ($r.Map['online'] -eq '2') "实际 $($r.Map['online'])"
Assert-True 'offline=1' ($r.Map['offline'] -eq '1') "实际 $($r.Map['offline'])"
Assert-True 'errors=1' ($r.Map['errors'] -eq '1') "实际 $($r.Map['errors'])"
Assert-True '状态栏说的是「已连接」' ($r.Map['line'] -like '*已连接*') "实际 $($r.Map['line'])"
Assert-True '状态栏带宿主 pid' ($r.Map['line'] -like '*pid 4242*') "实际 $($r.Map['line'])"
Assert-True '空状态为空（有目标就不该显示空状态）' ($r.Map['emptyText'] -eq '') "实际 $($r.Map['emptyText'])"

Write-Host "`n=== 2. 文件不存在 ===" -ForegroundColor Cyan
$r = Invoke-Dump (Join-Path $WorkDir 'nope-does-not-exist.json')
Assert-True '退出码 2' ($r.ExitCode -eq 2) "实际 $($r.ExitCode)"
Assert-True 'state=missing' ($r.Map['state'] -eq 'missing') "实际 $($r.Map['state'])"
Assert-True '状态栏说明是「状态文件不存在」' ($r.Map['line'] -like '*状态文件不存在*') "实际 $($r.Map['line'])"
Assert-True '状态栏带上了路径' ($r.Map['line'] -like '*nope-does-not-exist.json*') "实际 $($r.Map['line'])"

Write-Host "`n=== 3. JSON 语法坏了 ===" -ForegroundColor Cyan
$bad = Join-Path $WorkDir 'state-syntax.json'
Set-Content -Path $bad -Value "{`n  `"schema`": 1,`n  `"generatedAt`": 1700000000000,`n  `"host`": {`n" -Encoding utf8NoBOM
$r = Invoke-Dump $bad
Assert-True '退出码 3' ($r.ExitCode -eq 3) "实际 $($r.ExitCode)"
Assert-True 'state=parse-error' ($r.Map['state'] -eq 'parse-error') "实际 $($r.Map['state'])"
Assert-True '状态栏说明是「解析失败」' ($r.Map['line'] -like '*状态文件解析失败*') "实际 $($r.Map['line'])"
Assert-True '带上了出错的行号' ($r.Map['line'] -like '*第 *行*') "实际 $($r.Map['line'])"

Write-Host "`n=== 4. 枚举值非法（指向具体字段） ===" -ForegroundColor Cyan
$enum = Join-Path $WorkDir 'state-bad-enum.json'
$o = Get-Content $good -Raw | ConvertFrom-Json
$o.targets[1].status = 'down'
($o | ConvertTo-Json -Depth 16 -EscapeHandling Default) | Set-Content -Path $enum -Encoding utf8NoBOM
$r = Invoke-Dump $enum
Assert-True '退出码 3' ($r.ExitCode -eq 3) "实际 $($r.ExitCode)"
Assert-True '报出了具体字段路径 $."targets"[1]."status"' ($r.Map['line'] -like '*targets*[1]*status*') "实际 $($r.Map['line'])"
Assert-True '报出了非法取值与合法取值' (($r.Map['line'] -like '*未知状态*') -and ($r.Map['line'] -like '*online*offline*')) "实际 $($r.Map['line'])"

Write-Host "`n=== 5. 必填字段缺失 ===" -ForegroundColor Cyan
$missingField = Join-Path $WorkDir 'state-missing-field.json'
$o = Get-Content $good -Raw | ConvertFrom-Json
$o.targets[2].PSObject.Properties.Remove('kind')
($o | ConvertTo-Json -Depth 16 -EscapeHandling Default) | Set-Content -Path $missingField -Encoding utf8NoBOM
$r = Invoke-Dump $missingField
Assert-True '退出码 3' ($r.ExitCode -eq 3) "实际 $($r.ExitCode)"
Assert-True '报出「缺少必填字段 kind」' (($r.Map['line'] -like '*缺少必填字段*kind*')) "实际 $($r.Map['line'])"

Write-Host "`n=== 6. 类型不对（totals.online 给了字符串） ===" -ForegroundColor Cyan
$wrongType = Join-Path $WorkDir 'state-wrong-type.json'
$o = Get-Content $good -Raw | ConvertFrom-Json
$o.totals.online = 'two'
($o | ConvertTo-Json -Depth 16 -EscapeHandling Default) | Set-Content -Path $wrongType -Encoding utf8NoBOM
$r = Invoke-Dump $wrongType
Assert-True '退出码 3' ($r.ExitCode -eq 3) "实际 $($r.ExitCode)"
Assert-True '报出 totals.online 类型错' (($r.Map['line'] -like '*totals*online*') -and ($r.Map['line'] -like '*期望 数字*')) "实际 $($r.Map['line'])"

Write-Host "`n=== 7. 目标 id 重复 ===" -ForegroundColor Cyan
$dup = Join-Path $WorkDir 'state-dup-id.json'
$o = Get-Content $good -Raw | ConvertFrom-Json
$o.targets[1].id = 'wsl-ubuntu'
($o | ConvertTo-Json -Depth 16 -EscapeHandling Default) | Set-Content -Path $dup -Encoding utf8NoBOM
$r = Invoke-Dump $dup
Assert-True '退出码 3' ($r.ExitCode -eq 3) "实际 $($r.ExitCode)"
Assert-True '报出 id 重复' ($r.Map['line'] -like '*重复*') "实际 $($r.Map['line'])"

Write-Host "`n=== 8. 心跳丢失（stale） ===" -ForegroundColor Cyan
$stale = Join-Path $WorkDir 'state-stale.json'
$o = Get-Content $good -Raw | ConvertFrom-Json
$o.generatedAt = (NowMs) - 60000
($o | ConvertTo-Json -Depth 16 -EscapeHandling Default) | Set-Content -Path $stale -Encoding utf8NoBOM
$r = Invoke-Dump $stale 15
Assert-True '退出码 0（文件本身是对的）' ($r.ExitCode -eq 0) "实际 $($r.ExitCode)"
Assert-True 'state=stale' ($r.Map['state'] -eq 'stale') "实际 $($r.Map['state'])"
Assert-True '状态栏说明是「宿主心跳丢失」' ($r.Map['line'] -like '*宿主心跳丢失*') "实际 $($r.Map['line'])"
Assert-True '阈值出现在文案里' ($r.Map['line'] -like '*15s*') "实际 $($r.Map['line'])"

Write-Host "`n=== 9. 宿主已正常退出（最后一帧） ===" -ForegroundColor Cyan
$stopped = Join-Path $WorkDir 'state-stopped.json'
$o = Get-Content $good -Raw | ConvertFrom-Json
$o.host.stopped = $true
($o | ConvertTo-Json -Depth 16 -EscapeHandling Default) | Set-Content -Path $stopped -Encoding utf8NoBOM
$r = Invoke-Dump $stopped
Assert-True '退出码 0' ($r.ExitCode -eq 0) "实际 $($r.ExitCode)"
Assert-True 'state=host-stopped' ($r.Map['state'] -eq 'host-stopped') "实际 $($r.Map['state'])"
Assert-True '状态栏说明是「宿主已退出」' ($r.Map['line'] -like '*宿主已退出*') "实际 $($r.Map['line'])"
Assert-True 'hostStopped=true' ($r.Map['hostStopped'] -eq 'true') "实际 $($r.Map['hostStopped'])"

Write-Host "`n=== 10. 空文件 ===" -ForegroundColor Cyan
$empty = Join-Path $WorkDir 'state-empty.json'
Set-Content -Path $empty -Value '' -Encoding utf8NoBOM
$r = Invoke-Dump $empty
Assert-True '退出码 3' ($r.ExitCode -eq 3) "实际 $($r.ExitCode)"
Assert-True '状态栏说明是「解析失败」' ($r.Map['line'] -like '*状态文件解析失败*') "实际 $($r.Map['line'])"

Write-Host "`n=== 12. 头部摘要：探测中的目标仍算「在线」 ===" -ForegroundColor Cyan
# 这是实测发现的一个真 bug：两个目标都在重新探测的那一刻，标题写「0 在线」，
# 而卡片上明明渲染着上一次探测的完整指标 —— 读起来像全军覆没。
# 判定规则是「probing 但上一次成功过（lastOnlineAt 有值，或 metrics 还在）算在线」。
$probing = Join-Path $WorkDir 'state-probing.json'
$o = Get-Content $good -Raw | ConvertFrom-Json
$o.targets[1].status = 'probing'
($o | ConvertTo-Json -Depth 16 -EscapeHandling Default) | Set-Content -Path $probing -Encoding utf8NoBOM
$r = Invoke-Dump $probing
Assert-True 'probing + 有上次指标 → onlineCounted=2' ($r.Map['onlineCounted'] -eq '2') "实际 $($r.Map['onlineCounted'])"
Assert-True '标题写「2 在线」而不是「0 在线」' ($r.Map['header'] -eq '3 个目标 · 2 在线') "实际 $($r.Map['header'])"
Assert-True '同时给出「1 探测中」' ($r.Map['probingText'] -eq '· 1 探测中') "实际 $($r.Map['probingText'])"
Assert-True '探测中不算失败' ($r.Map['failingText'] -eq '· 1 失败') "实际 $($r.Map['failingText'])"

$probingCold = Join-Path $WorkDir 'state-probing-cold.json'
$o = Get-Content $good -Raw | ConvertFrom-Json
$o.targets[1].status = 'probing'
$o.targets[1].metrics = $null
$o.targets[1].PSObject.Properties.Remove('lastOnlineAt')
($o | ConvertTo-Json -Depth 16 -EscapeHandling Default) | Set-Content -Path $probingCold -Encoding utf8NoBOM
$r = Invoke-Dump $probingCold
Assert-True 'probing 且从没成功过（无 metrics/lastOnlineAt）→ 不算在线' ($r.Map['onlineCounted'] -eq '1') "实际 $($r.Map['onlineCounted'])"
Assert-True '标题写「1 在线」' ($r.Map['header'] -eq '3 个目标 · 1 在线') "实际 $($r.Map['header'])"

Write-Host "`n=== 13. --help ===" -ForegroundColor Cyan
$helpPsi = [System.Diagnostics.ProcessStartInfo]::new()
$helpPsi.FileName = $Exe
$helpPsi.ArgumentList.Add('--help')
$helpPsi.RedirectStandardOutput = $true
$helpPsi.StandardOutputEncoding = [System.Text.Encoding]::UTF8
$helpPsi.UseShellExecute = $false
$helpPsi.CreateNoWindow = $true
$helpProc = [System.Diagnostics.Process]::Start($helpPsi)
$help = $helpProc.StandardOutput.ReadToEnd()
$helpProc.WaitForExit()
$helpCode = $helpProc.ExitCode
$helpProc.Dispose()
Assert-True '退出码 0' ($helpCode -eq 0) "实际 $helpCode"
Assert-True '打印了用法' ($help -like '*--stale-seconds*' -and $help -like '*--dump-status*')

# ---------------------------------------------------------------------------
Write-Host ""
if ($script:fail -eq 0) {
    Write-Host ("全部通过：{0} 项断言" -f $script:pass) -ForegroundColor Green
    exit 0
}
Write-Host ("失败 {0} 项 / 共 {1} 项" -f $script:fail, ($script:pass + $script:fail)) -ForegroundColor Red
exit 1

