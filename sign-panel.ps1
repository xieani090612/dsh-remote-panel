<#
.SYNOPSIS
    给 WsxPanel.exe 自签名，消除「无法验证发布者」的安全警告。

.DESCRIPTION
    警告的原因是这个 exe **没有代码签名**。Windows 对没有签名的可执行文件会提示
    「无法验证发布者 — 你确定要运行此软件吗」。要消除它只能签名，而签名需要一张
    证书；本机没有商业代码签名证书，所以这里用**自签名**证书。

    这个脚本做四件事（每一步都可单独审阅、可单独回滚）：
      1. 在当前用户的「个人」证书库里创建（或复用）一张代码签名证书；
      2. 把它的**公钥**加进当前用户的「受信任的根证书颁发机构」与「受信任的发布者」；
      3. 用它对 dist\WsxPanel.exe 签名；
      4. 验证签名结果。

    安全边界（请先读完再决定要不要跑）：
      * 只写 **CurrentUser** 存储（HKCU），**不碰** LocalMachine / 系统级信任库，不需要管理员；
      * 装进「受信任的根」意味着**这个用户**信任由这张证书签发的任何东西。
        这是自签名的固有代价 —— 想撤销就删掉那张证书（见文末 -Uninstall）。
      * 证书私钥留在用户证书库里（可导出、受当前用户登录保护）。它只用来给本插件的
        exe 签名，没有别的用途。

.PARAMETER ExePath
    要签名的 exe。默认 dist\WsxPanel.exe。

.PARAMETER Subject
    证书主题。默认 "CN=DshWsxPanel Local Dev"。

.PARAMETER Uninstall
    反向操作：删除证书与签名。用于撤回这次改动。

.EXAMPLE
    pwsh -File .\sign-panel.ps1
    pwsh -File .\sign-panel.ps1 -Uninstall
#>
[CmdletBinding()]
param(
    [string]$ExePath,
    [string]$Subject = 'CN=DshWsxPanel Local Dev',
    [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$pluginRoot = $PSScriptRoot
if (-not $ExePath) { $ExePath = Join-Path $pluginRoot 'dist\WsxPanel.exe' }

function Write-Step($text) { Write-Host "==> $text" -ForegroundColor Cyan }
function Write-Ok($text) { Write-Host "    $text" -ForegroundColor Green }
function Write-Warn2($text) { Write-Host "    $text" -ForegroundColor Yellow }

# ---------------------------------------------------------------------------
# -Uninstall：撤销
# ---------------------------------------------------------------------------
if ($Uninstall) {
    Write-Step "撤销自签名改动"

    # 先移除 exe 上的签名（删掉证书后签名本来也会失效，但显式做一遍更干净）
    if (Test-Path $ExePath) {
        try {
            # 【已知限制】exe 里那段签名数据本身没法用脚本干净剥掉：
            #   * Set-AuthenticodeSignature 没有「移除签名」参数
            #     （写 -Signature $null 会报「找不到名为 Signature 的参数」）；
            #   * .NET Core 也没有公开 SignerInfo.RemoveSignature()，那套 API
            #     只存在于 .NET Framework 的 CryptUI 里，PowerShell 7 拿不到。
            # 但这**不影响撤销效果**：下面会把证书从三个存储里删掉，签名随即失去
            # 信任链，Get-AuthenticodeSignature 立刻变成 UnknownError ——
            # 也就是回到「没签名」等效的状态。所以这里只提示，不算失败。
            Write-Warn2 "保留 exe 内的签名数据（证书删除后它已失效，等效于未签名）"
        } catch {
            Write-Warn2 "移除签名失败：$($_.Exception.Message)"
        }
    } else {
        Write-Warn2 "找不到 $ExePath，跳过签名移除"
    }

    # 注意顺序与容错：
    #   * CurrentUser\Root 是受保护存储，用 Remove-Item 删会报
    #     「此操作针对用户根存储，不允许使用 UI」。要删得用 .NET 的
    #     X509Store(StoreName.Root, StoreLocation.CurrentUser)，并打开 ReadWrite。
    #   * 这一步失败**不影响**前面的签名移除，所以单独 try/catch，不让整段中断。
    foreach ($storeName in 'Root', 'TrustedPublisher', 'My') {
        try {
            $store = New-Object System.Security.Cryptography.X509Certificates.X509Store($storeName, 'CurrentUser')
            $store.Open('ReadWrite')
            $targets = @($store.Certificates | Where-Object { $_.Subject -eq $Subject })
            foreach ($c in $targets) {
                $store.Remove($c)
                Write-Ok "已从 CurrentUser\$storeName 移除证书 $($c.Thumbprint)"
            }
            $store.Close()
        } catch {
            Write-Warn2 "从 CurrentUser\$storeName 移除失败：$($_.Exception.Message)"
        }
    }

    Write-Host ''
    Write-Host "撤销完成。下次启动会重新出现「无法验证发布者」的提示。" -ForegroundColor Yellow
    return
}

# ---------------------------------------------------------------------------
# 0. 前置检查
# ---------------------------------------------------------------------------
Write-Step "检查环境"
if (-not (Test-Path $ExePath)) {
    throw "找不到 $ExePath。先运行 .\build.ps1 -Pack 生成面板。"
}
Write-Ok "目标 exe：$ExePath ($([math]::Round((Get-Item $ExePath).Length/1KB)) KB)"

$existing = Get-ChildItem Cert:\CurrentUser\My -ErrorAction SilentlyContinue |
    Where-Object { $_.Subject -eq $Subject -and $_.HasPrivateKey } |
    Sort-Object NotAfter -Descending |
    Select-Object -First 1

# ---------------------------------------------------------------------------
# 1. 创建（或复用）代码签名证书
# ---------------------------------------------------------------------------
$cert = $null
if ($existing) {
    Write-Step "复用已有的代码签名证书"
    $cert = $existing
    Write-Ok "指纹 $($cert.Thumbprint)，有效期至 $($cert.NotAfter.ToString('yyyy-MM-dd'))"
} else {
    Write-Step "创建代码签名证书（CurrentUser\My）"
    $cert = New-SelfSignedCertificate `
        -Subject $Subject `
        -Type CodeSigningCert `
        -CertStoreLocation 'Cert:\CurrentUser\My' `
        -KeyUsage DigitalSignature `
        -KeyAlgorithm RSA `
        -KeyLength 2048 `
        -NotAfter (Get-Date).AddYears(5) `
        -TextExtension @('2.5.29.37={text}1.3.6.1.5.5.7.3.3')
    Write-Ok "指纹 $($cert.Thumbprint)，有效期至 $($cert.NotAfter.ToString('yyyy-MM-dd'))"
}

# ---------------------------------------------------------------------------
# 2. 把公钥装进受信任存储
# ---------------------------------------------------------------------------
Write-Step "把公钥加入当前用户的受信任存储"
foreach ($store in 'Root', 'TrustedPublisher') {
    $already = Get-ChildItem "Cert:\CurrentUser\$store" -ErrorAction SilentlyContinue |
        Where-Object { $_.Thumbprint -eq $cert.Thumbprint }
    if ($already) {
        Write-Ok "CurrentUser\$store 已存在该证书，跳过"
        continue
    }
    try {
        $null = Export-Certificate -Cert $cert -FilePath (Join-Path $env:TEMP "wsx-$($cert.Thumbprint).cer") -Force
        Import-Certificate -FilePath (Join-Path $env:TEMP "wsx-$($cert.Thumbprint).cer") -CertStoreLocation "Cert:\CurrentUser\$store" | Out-Null
        Remove-Item (Join-Path $env:TEMP "wsx-$($cert.Thumbprint).cer") -Force -ErrorAction SilentlyContinue
        Write-Ok "已加入 CurrentUser\$store"
    } catch {
        Write-Warn2 "加入 CurrentUser\$store 失败：$($_.Exception.Message)"
    }
}

# ---------------------------------------------------------------------------
# 3. 签名
# ---------------------------------------------------------------------------
Write-Step "给 exe 签名"
$result = Set-AuthenticodeSignature -FilePath $ExePath -Certificate $cert -HashAlgorithm SHA256
Write-Ok "签名状态：$($result.Status)"

# ---------------------------------------------------------------------------
# 4. 验证
# ---------------------------------------------------------------------------
Write-Step "验证签名"
$check = Get-AuthenticodeSignature -FilePath $ExePath
Write-Host "    状态      : $($check.Status)"
Write-Host "    签名者    : $($check.SignerCertificate.Subject)"
Write-Host "    指纹      : $($check.SignerCertificate.Thumbprint)"
Write-Host "    时间戳    : $(if ($check.TimeStamperCertificate) { '有' } else { '无（自签名不需要）' })"
Write-Host ""

if ($check.Status -eq 'Valid') {
    Write-Host "完成：签名有效，重新打开面板应当不再出现「无法验证发布者」。" -ForegroundColor Green
    Write-Host "注意：这只对**本机当前用户**生效；把 dist 拷到别的机器仍会提示未签名。" -ForegroundColor DarkGray
    Write-Host "想撤销：pwsh -File .\sign-panel.ps1 -Uninstall" -ForegroundColor DarkGray
} else {
    Write-Host "签名状态不是 Valid（$($check.Status)）。可能原因：证书未进入受信任的根。" -ForegroundColor Yellow
    Write-Host "可以重跑一次本脚本；仍旧不行就在 -Uninstall 后重来。" -ForegroundColor Yellow
}
