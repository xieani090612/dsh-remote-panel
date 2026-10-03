# 把 dsh-remote-panel 的仓库内容用 GitHub REST API 上传成一个初始提交。
#
# 为什么走 API 而不是 git：这台机器上**没有 git，也没有 gh**（只有 curl）。
# 走 Git Data API 的好处是能一次提交全部文件（blobs -> tree -> commit），
# 而不是给每个文件打一个 commit（那样初始历史会有 73 个提交）。
#
# 令牌通过环境变量 GH_TOKEN 传入，**不写进任何文件**。

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$Owner = 'xieani090612'
$Repo = 'dsh-remote-panel'
$Branch = 'main'
$Root = 'C:\Users\xaq18\Documents\harness\dsh-remote-panel'
$Api = 'https://api.github.com'

$token = $env:GH_TOKEN
if (-not $token) { throw 'GH_TOKEN 环境变量没有设置' }

function Gh {
  param([string]$Method, [string]$Path, $Body, [switch]$Raw)
  $uri = if ($Path -like 'http*') { $Path } else { "$Api$Path" }
  $args = @('-s', '-X', $Method, $uri,
    '-H', "Authorization: Bearer $token",
    '-H', 'Accept: application/vnd.github+json',
    '-H', 'X-GitHub-Api-Version: 2022-11-28',
    '-H', 'User-Agent: dsh-remote-panel-release')
  if ($null -ne $Body) {
    $json = if ($Body -is [string]) { $Body } else { $Body | ConvertTo-Json -Depth 20 -Compress }
    $tmp = [System.IO.Path]::GetTempFileName()
    [System.IO.File]::WriteAllText($tmp, $json, (New-Object System.Text.UTF8Encoding($false)))
    $args += @('--data-binary', "@$tmp", '-H', 'Content-Type: application/json')
  }
  $out = & curl.exe @args
  if ($null -ne $Body) { Remove-Item $tmp -Force -ErrorAction SilentlyContinue }
  if ($Raw) { return $out }
  return ($out | ConvertFrom-Json)
}

# ---------------------------------------------------------------------------
Write-Host '==> 读取当前 main 的 HEAD' -ForegroundColor Cyan
$ref = Gh GET "/repos/$Owner/$Repo/git/ref/heads/$Branch"
$baseSha = $ref.object.sha
if (-not $baseSha) {
  # 空仓库：没有任何 ref，需要从一个空 tree 起步
  Write-Host '    仓库为空（没有 ref），从零开始' -ForegroundColor Yellow
  $baseSha = $null
} else {
  Write-Host "    base commit: $baseSha"
}

# ---------------------------------------------------------------------------
# 收集要上传的文件（与 .gitignore 一致：不带 dist/ release/ app/bin app/obj）
# ---------------------------------------------------------------------------
$ignore = @('\\dist\\', '\\release\\', '\\app\\bin\\', '\\app\\obj\\')
$files = @(Get-ChildItem $Root -Recurse -File -Force | Where-Object {
    $f = $_.FullName
    -not ($ignore | Where-Object { $f -match $_ })
  })
Write-Host "==> 准备上传 $($files.Count) 个文件" -ForegroundColor Cyan

# ---------------------------------------------------------------------------
# 逐个创建 blob
# ---------------------------------------------------------------------------
$treeEntries = New-Object System.Collections.Generic.List[object]
$n = 0
foreach ($f in $files) {
  $n++
  $rel = $f.FullName.Substring($Root.Length + 1).Replace('\', '/')
  $bytes = [System.IO.File]::ReadAllBytes($f.FullName)
  $b64 = [System.Convert]::ToBase64String($bytes)

  $blob = Gh POST "/repos/$Owner/$Repo/git/blobs" @{ content = $b64; encoding = 'base64' }
  if (-not $blob.sha) { throw "创建 blob 失败：$rel -> $($blob.message)" }

  $treeEntries.Add(@{
      path = $rel
      mode = '100644'          # 普通文件；可执行位由 scripts/probe.sh 的用法决定，仓库里不必带 +x
      type = 'blob'
      sha  = $blob.sha
    })

  if ($n % 10 -eq 0 -or $n -eq $files.Count) {
    Write-Host ("    {0}/{1}" -f $n, $files.Count) -ForegroundColor DarkGray
  }
}

# ---------------------------------------------------------------------------
# 建 tree + commit + 推 ref
# ---------------------------------------------------------------------------
Write-Host '==> 创建 tree' -ForegroundColor Cyan
$treeBody = @{ tree = $treeEntries }
if ($baseSha) { $treeBody.base_tree = (Gh GET "/repos/$Owner/$Repo/git/commits/$baseSha").tree.sha }
$tree = Gh POST "/repos/$Owner/$Repo/git/trees" $treeBody
if (-not $tree.sha) { throw "创建 tree 失败：$($tree.message)" }
Write-Host "    tree: $($tree.sha)"

Write-Host '==> 创建 commit' -ForegroundColor Cyan
$commitBody = @{
  message = @'
Initial commit: dsh-remote-panel 0.1.1

A DSH (DeepSeek Harness) plugin that probes local WSL distributions and remote
machines over SSH (CPU, memory, disk, GPU, Docker, processes, systemd services)
and surfaces one atomic JSON snapshot four ways: a standalone WinUI 3 panel, an
in-GUI web panel, /wsx session commands, and 7 remote_* agent tools -- plus a
zero-dependency MCP stdio server and two agent Skills.

- 73 files; the prebuilt panel (dist/, ~163 MB) ships in the release archive
  rather than the repository.
- Docs are bilingual (Chinese first, English second).
- Tests: 7 suites / 139 checks (node test/run-all.mjs), including release gates
  that fail the build if any doc loses its Chinese or leaks personal data.

Co-authored-by: DSH <noreply@deepseek.com>
'@
  tree = $tree.sha
}
$parents = @()
if ($baseSha) { $parents += $baseSha }
if ($parents.Count) { $commitBody.parents = $parents }
$commit = Gh POST "/repos/$Owner/$Repo/git/commits" $commitBody
if (-not $commit.sha) { throw "创建 commit 失败：$($commit.message)" }
Write-Host "    commit: $($commit.sha)"

Write-Host '==> 更新 main 引用' -ForegroundColor Cyan
if ($baseSha) {
  $res = Gh PATCH "/repos/$Owner/$Repo/git/refs/heads/$Branch" @{ sha = $commit.sha; force = $false }
} else {
  $res = Gh POST "/repos/$Owner/$Repo/git/refs" @{ ref = "refs/heads/$Branch"; sha = $commit.sha }
}
if ($res.object.sha -ne $commit.sha) { throw "更新 ref 失败：$($res.message)" }
Write-Host "    main -> $($res.object.sha)" -ForegroundColor Green

Write-Host ''
Write-Host "完成：https://github.com/$Owner/$Repo" -ForegroundColor Green
