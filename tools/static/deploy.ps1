<#
.SYNOPSIS
  把 BDIA-3D-Navigator 静态站点部署到 S3 + CloudFront。

.EXAMPLE
  .\deploy.ps1 -Bucket my-bucket -DistributionId E1234567890ABC -DryRun
  .\deploy.ps1 -Bucket my-bucket -DistributionId E1234567890ABC
  .\deploy.ps1 -Bucket my-bucket -Prefix BDIA-3D-Navigator -DistributionId E1234567890ABC

.NOTES
  ★ 为什么要分三趟传，而不是一条 aws s3 sync 完事：

    ① 浏览器对 ES module 做【严格 MIME 检查】。.mjs / .js 的 Content-Type
       不是 JavaScript 类型就会被直接拒绝执行，控制台只留一句
       "Failed to load module script"，而 AWS CLI 对 .mjs 不一定猜得对。
    ② aws s3 sync 靠「大小 + 修改时间」判断要不要传。
       先传一趟、再想用第二趟改元数据是【不会生效】的 —— 第二趟会认为文件没变而跳过。
       所以每类文件必须在【唯一一趟】里带着自己的元数据传上去，不能先传后改。
    ③ 缓存策略不同：带哈希思路的静态资源可以长缓存，index.html 和 api/data.json 不行。
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Bucket,
  [string]$Prefix = '',
  [string]$DistributionId = '',
  [string]$Profile = '',
  [string]$Region = '',
  [switch]$DryRun,
  [switch]$Prune,
  [switch]$InvalidateAll
)

$ErrorActionPreference = 'Stop'
$SiteDir = $PSScriptRoot

function Say($msg)  { Write-Host $msg }
function Ok($msg)   { Write-Host "  ok   $msg" -ForegroundColor Green }
function Fail($msg) { Write-Host "  FAIL $msg" -ForegroundColor Red; exit 1 }

$prefixClean = $Prefix.Trim('/')
if ($prefixClean) { $dest = "s3://$Bucket/$prefixClean" } else { $dest = "s3://$Bucket" }

# aws 的公共参数
$awsCommon = @()
if ($Profile) { $awsCommon += @('--profile', $Profile) }
if ($Region)  { $awsCommon += @('--region', $Region) }

Say ''
Say '  BDIA 3D Navigator —— 部署到 S3 + CloudFront'
Say ('  ' + ('─' * 62))
Say "  站点目录   $SiteDir"
Say "  目标       $dest"
if ($DistributionId) { Say "  分发       $DistributionId" }
if ($DryRun) { Say '  模式       预览（不会真的上传）' }
Say ''

# ── 0. 前置检查 ───────────────────────────────────────────────
if (-not (Get-Command aws -ErrorAction SilentlyContinue)) {
  Fail '找不到 AWS CLI。装一个：https://aws.amazon.com/cli/　或者照本脚本里的命令手工敲。'
}
foreach ($f in @('index.html', 'app.js', 'static-api.js', 'api/data.json', 'build-manifest.json')) {
  if (-not (Test-Path (Join-Path $SiteDir $f))) {
    Fail "站点里缺少 $f —— 先跑 `npm run build:static` 重新构建。"
  }
}
if ($Prune -and -not $Prefix) { Fail '-Prune 需要同时指定 -Prefix，否则会把整个桶当作站点目录来清理。' }

# 构建信息（顺便确认 manifest 是新的）
try {
  $manifest = Get-Content (Join-Path $SiteDir 'build-manifest.json') -Raw | ConvertFrom-Json
  Ok "构建于 $($manifest.builtAt)　设施 $($manifest.counts.facilities) · 通行线 $($manifest.counts.paths)"
} catch {
  Say "  warn build-manifest.json 读不出来（不影响部署）"
}

$dry = @()
if ($DryRun) { $dry = @('--dryrun') }

# ── 1. 静态资源：长缓存，Content-Type 让 CLI 按扩展名猜 ──────────
Say ''
Say '  [1/4] 图片 / SVG 等静态资源　→ max-age=31536000, immutable'
$r = & aws s3 sync $SiteDir $dest `
  --exclude '*' --include 'client/assets/*' --include 'thumbnail.svg' `
  --cache-control 'public, max-age=31536000, immutable' `
  @dry @awsCommon
if ($LASTEXITCODE -ne 0) { Fail "静态资源同步失败（aws 退出码 $LASTEXITCODE）" }
Ok '完成'

# ── 2. 脚本：★ 必须显式指定 JavaScript 的 Content-Type ──────────
Say ''
Say '  [2/4] *.js / *.mjs　→ text/javascript（ES module 严格 MIME 检查，错了直接不执行）'
$r = & aws s3 sync $SiteDir $dest `
  --exclude '*' --include '*.js' --include '*.mjs' `
  --content-type 'text/javascript; charset=utf-8' `
  --cache-control 'public, max-age=31536000, immutable' `
  @dry @awsCommon
if ($LASTEXITCODE -ne 0) { Fail "脚本同步失败（aws 退出码 $LASTEXITCODE）" }
Ok '完成'

# ── 3. 入口与数据：必须每次回源校验 ─────────────────────────────
Say ''
Say '  [3/4] 两个 index.html + api/data.json　→ no-cache'
$r = & aws s3 sync $SiteDir $dest `
  --exclude '*' --include 'index.html' --include 'client/index.html' `
  --include 'client/api/data.json' --include 'build-manifest.json' `
  --cache-control 'no-cache' `
  @dry @awsCommon
if ($LASTEXITCODE -ne 0) { Fail "入口同步失败（aws 退出码 $LASTEXITCODE）" }
Ok '完成'

# ── 4. 清理远端多余对象（可选） ─────────────────────────────────
if ($Prune -and -not $DryRun) {
  Say ''
  Say '  [4/4] 清理远端多余对象'
  $local = @{}
  Get-ChildItem -Path $SiteDir -Recurse -File | ForEach-Object {
    $rel = $_.FullName.Substring($SiteDir.Length).TrimStart('\', '/').Replace('\', '/')
    if ($rel -eq 'deploy.ps1' -or $rel -eq 'README.md') { return }
    $local[$rel] = $true
  }
  $listArgs = @('s3api', 'list-objects-v2', '--bucket', $Bucket, '--query', 'Contents[].Key', '--output', 'text') + $awsCommon
  if ($prefixClean) { $listArgs += @('--prefix', "$prefixClean/") }
  $keys = (& aws @listArgs) -split '\s+' | Where-Object { $_ }
  $stale = @()
  foreach ($k in $keys) {
    $rel = $k
    if ($prefixClean -and $k.StartsWith("$prefixClean/")) { $rel = $k.Substring($prefixClean.Length + 1) }
    if ($rel -eq 'deploy.ps1' -or $rel -eq 'README.md') { continue }
    if (-not $local.ContainsKey($rel)) { $stale += $k }
  }
  if ($stale.Count -eq 0) {
    Ok '没有多余对象'
  } else {
    Say "  删除 $($stale.Count) 个："
    foreach ($k in $stale) { Say "    - $k" }
    foreach ($k in $stale) {
      & aws s3 rm "s3://$Bucket/$k" @awsCommon | Out-Null
      if ($LASTEXITCODE -ne 0) { Fail "删除 $k 失败" }
    }
    Ok '完成'
  }
} else {
  Say ''
  Say '  [4/4] 跳过清理（要清理加 -Prune）'
}

# ── 5. 失效 CloudFront 缓存 ─────────────────────────────────────
if ($DistributionId) {
  Say ''
  Say '  失效 CloudFront 缓存'
  $paths = @('/index.html', '/client/index.html', '/client/api/data.json')
  if ($InvalidateAll) { $paths = @('/*') }
  $inv = & aws cloudfront create-invalidation --distribution-id $DistributionId --paths @paths @dry @awsCommon --output json
  if ($LASTEXITCODE -ne 0) { Fail '创建失效任务失败' }
  Ok "$($paths -join ' ') 已提交失效"
} else {
  Say ''
  Say '  未提供 -DistributionId，跳过缓存失效'
  Say '  ★ 但 api/data.json 是 no-cache，不失效的话用户可能仍拿到旧数据'
}

Say ''
Say ('  ' + ('─' * 62))
if ($DryRun) { Say '  预览结束（什么都没传）' } else { Say '  部署完成' }
Say ''
