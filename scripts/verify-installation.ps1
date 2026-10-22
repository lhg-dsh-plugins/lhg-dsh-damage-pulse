<#
  dsh-damage-pulse 原生侧边栏会话金额（标准包能力）验证：
  新宿主通过 sidebar.workspaces.sessionRow.trailing 正式席位原生显示金额；
  旧版/社区打包客户端由标准包内置的 fail-closed 兼容桥安全显示，均无需手工改宿主源码。
  仅当你在完整 DSH 源码上手工运行 apply-sidebar-integration.ps1 后，本脚本用于核对挂载结果；
  标准包已显示金额时不要再手工挂载，避免重复写入。
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$HarnessRoot
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$root = (Resolve-Path -LiteralPath $HarnessRoot).Path
$checks = [ordered]@{
  'Host plugin source' = Join-Path $root 'plugins\dsh-token-monitor\src\index.ts'
  'Client plugin source' = Join-Path $root 'packages\client\ui-token-monitor\src\client\index.ts'
  'Client plugin bundle' = Join-Path $root 'packages\client\ui-token-monitor\lib\client.js'
  'Sidebar tree source' = Join-Path $root 'packages\client\ui-workspace\src\client\tree.ts'
  'Sidebar row source' = Join-Path $root 'packages\client\ui-workspace\src\client\rows\Rows.tsx'
  'Sidebar style source' = Join-Path $root 'packages\client\ui-workspace\src\client\rows\Rows.module.css'
  'Sidebar bundle' = Join-Path $root 'packages\client\ui-workspace\lib\client.js'
  'Web composition patch' = Join-Path $root 'packages\bundle\web-app\cordis.patch.yml'
}

$failed = $false
foreach ($entry in $checks.GetEnumerator()) {
  if (Test-Path -LiteralPath $entry.Value -PathType Leaf) {
    Write-Host "[OK] $($entry.Key)"
  } else {
    Write-Host "[MISSING] $($entry.Key): $($entry.Value)" -ForegroundColor Red
    $failed = $true
  }
}

if (-not $failed) {
  $tree = [System.IO.File]::ReadAllText($checks['Sidebar tree source'])
  $webPatch = [System.IO.File]::ReadAllText($checks['Web composition patch'])
  $sidebarBundle = [System.IO.File]::ReadAllText($checks['Sidebar bundle'])
  $clientBundle = [System.IO.File]::ReadAllText($checks['Client plugin bundle'])

  $seatDeclared = $sidebarBundle.Contains('data-session-row-trailing-slot') `
    -or $sidebarBundle.Contains('sessionRow.trailing') `
    -or $tree.Contains('sessionRow.trailing')
  $legacyPatchPresent = $tree.Contains('function sessionCost(') -and $sidebarBundle.Contains('Session cost')

  $contentChecks = [ordered]@{
    'Standard client bundle carries session-row capability' = $clientBundle.Contains('data-session-row-trailing-slot') -and $clientBundle.Contains('sidebar.workspaces.sessionRow.trailing')
    'Host seat declared or legacy bridge available' = $seatDeclared -or $clientBundle.Contains('data-session-row-trailing-slot')
    'Client composition mount' = $webPatch.Contains('@deepseek-ai/dsh-client-ui-token-monitor')
  }
  foreach ($entry in $contentChecks.GetEnumerator()) {
    if ($entry.Value) {
      Write-Host "[OK] $($entry.Key)"
    } else {
      Write-Host "[FAILED] $($entry.Key)" -ForegroundColor Red
      $failed = $true
    }
  }

  if ($seatDeclared) {
    Write-Host '[NOTE] Host ui-workspace declares the native trailing seat; the standard package renders amounts through the formal slot.'
  } else {
    Write-Host '[NOTE] Host ui-workspace has no native trailing seat (old/community build); the standard package legacy bridge renders amounts fail-closed. No source edits required.'
  }
  if ($legacyPatchPresent) {
    Write-Host '[WARN] Manual sidebar source patch detected (sessionCost). The standard package detects existing amounts and stops its own fallback; remove the manual patch to avoid duplication.'
  }
}

if ($failed) {
  throw 'dsh-damage-pulse installation verification failed. Fix the items above.'
}

Write-Host 'dsh-damage-pulse: Host, Client capabilities, and sidebar entries verified.'
