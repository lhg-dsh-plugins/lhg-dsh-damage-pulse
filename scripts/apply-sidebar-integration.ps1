<#
  dsh-damage-pulse 原生侧边栏会话金额（开发/历史兼容工具，供完整 DSH 源码部署）：
  新宿主通过 sidebar.workspaces.sessionRow.trailing 正式席位由标准包原生显示金额；
  旧版/社区打包客户端由标准包内置的 fail-closed 兼容桥安全显示。本脚本仅用于
  在完整 DSH 源码上手工挂载（带备份、幂等、结构不匹配即停止）。
  若宿主已声明正式席位/稳定会话行标记（sessionRow.trailing、data-session-row-trailing-slot、
  data-session-id）或标准包已显示金额，脚本会直接退出，避免重复写入。
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$HarnessRoot
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Read-Utf8File([string]$Path) {
  return [System.IO.File]::ReadAllText($Path, [System.Text.Encoding]::UTF8)
}

function Write-Utf8File([string]$Path, [string]$Content) {
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($Path, $Content, $utf8NoBom)
}

function Replace-Once(
  [string]$Content,
  [string]$Old,
  [string]$New,
  [string]$Description
) {
  $first = $Content.IndexOf($Old, [StringComparison]::Ordinal)
  if ($first -lt 0) {
    throw "Could not locate $Description. The ui-workspace source layout may have changed; no files were written."
  }
  if ($Content.IndexOf($Old, $first + $Old.Length, [StringComparison]::Ordinal) -ge 0) {
    throw "Found $Description more than once; no files were written."
  }
  return $Content.Substring(0, $first) + $New + $Content.Substring($first + $Old.Length)
}

$root = (Resolve-Path -LiteralPath $HarnessRoot).Path
$workspaceRoot = Join-Path $root 'packages\client\ui-workspace'
$treePath = Join-Path $workspaceRoot 'src\client\tree.ts'
$rowsPath = Join-Path $workspaceRoot 'src\client\rows\Rows.tsx'
$cssPath = Join-Path $workspaceRoot 'src\client\rows\Rows.module.css'
$targets = @(
  @{ Path = $treePath; RelativePath = 'packages\client\ui-workspace\src\client\tree.ts' },
  @{ Path = $rowsPath; RelativePath = 'packages\client\ui-workspace\src\client\rows\Rows.tsx' },
  @{ Path = $cssPath; RelativePath = 'packages\client\ui-workspace\src\client\rows\Rows.module.css' }
)

foreach ($target in $targets) {
  if (-not (Test-Path -LiteralPath $target.Path -PathType Leaf)) {
    throw "Missing Harness file: $($target.Path)"
  }
}

$tree = (Read-Utf8File $treePath).Replace("`r`n", "`n")
$rows = (Read-Utf8File $rowsPath).Replace("`r`n", "`n")
$css = (Read-Utf8File $cssPath).Replace("`r`n", "`n")

# 标准包能力预检：宿主已声明正式席位或稳定会话行标记时不再手工挂载，避免双写。
$workspaceBundlePath = Join-Path $workspaceRoot 'lib\client.js'
$workspaceBundleText = ''
if (Test-Path -LiteralPath $workspaceBundlePath -PathType Leaf) {
  $workspaceBundleText = (Read-Utf8File $workspaceBundlePath).Replace("`r`n", "`n")
}
$nativeSeatDeclared = (($tree + $rows + $css + $workspaceBundleText).Contains('sessionRow.trailing')) `
  -or (($tree + $workspaceBundleText).Contains('data-session-row-trailing-slot')) `
  -or (($tree + $workspaceBundleText).Contains('data-session-id'))
if ($nativeSeatDeclared) {
  Write-Host 'dsh-damage-pulse: the target harness already declares the native sidebar trailing seat (or stable session-row markers); the standard package renders session amounts natively. No manual patch applied.'
  exit 0
}

$treeInstalled = $tree.Contains('function sessionCost(') -and $tree.Contains('tokenCost?.cost')
$rowsInstalled = $rows.Contains('function costLabel(') -and $rows.Contains('className={css.cost}')
$cssInstalled = $css.Contains('.cost {') -and $css.Contains('.sessionRow:hover .cost')

if ($treeInstalled -and $rowsInstalled -and $cssInstalled) {
  Write-Host 'dsh-damage-pulse: sidebar cost integration is already installed.'
  exit 0
}

if (-not $treeInstalled) {
  $tree = Replace-Once $tree @'
  completed: boolean
  updatedAt: number
}
'@ @'
  completed: boolean
  updatedAt: number
  /** Accumulated session cost from the tokenCost list projection. */
  cost?: number
}
'@ 'the SessionNode cost field'

  $tree = Replace-Once $tree @'
function sessionNode(
'@ @'
/** Read the accumulated cost from the dsh-damage-pulse list projection. */
function sessionCost(s: SessionSummary): number | undefined {
  const tokenCost = (s.projectionValues as { tokenCost?: { cost?: number } } | undefined)?.tokenCost
  return tokenCost?.cost
}

function sessionNode(
'@ 'the sessionCost reader'

  $tree = Replace-Once $tree @'
): SessionNode {
  return {
'@ @'
): SessionNode {
  const cost = sessionCost(s)
  return {
'@ 'the sessionNode cost read'

  $tree = Replace-Once $tree @'
    updatedAt: s.updatedAt,
    ...(s.pendingInteraction === undefined ? {} : { pendingInteraction: s.pendingInteraction }),
'@ @'
    updatedAt: s.updatedAt,
    ...(cost === undefined || cost === 0 ? {} : { cost }),
    ...(s.pendingInteraction === undefined ? {} : { pendingInteraction: s.pendingInteraction }),
'@ 'the SessionNode cost output'
}

if (-not $rowsInstalled) {
  $rows = Replace-Once $rows @'
function hoverTimeLabel(updatedAt: number, now: number, t: RowTranslate): string {
'@ @'
/** Keep tiny costs readable while using two decimals for ordinary values. */
function costLabel(cost: number): string {
  if (cost < 0.01) return `\u00a5${cost.toFixed(4)}`
  return `\u00a5${cost.toFixed(2)}`
}

function hoverTimeLabel(updatedAt: number, now: number, t: RowTranslate): string {
'@ 'the sidebar cost formatter'

  $rows = Replace-Once $rows @'
      {!row.blank && <span className={css.time}>{timeLabel(row.updatedAt, now, t)}</span>}
'@ @'
      {!row.blank && row.cost !== undefined && (
        <span className={css.cost} title="Session cost">{costLabel(row.cost)}</span>
      )}
      {!row.blank && <span className={css.time}>{timeLabel(row.updatedAt, now, t)}</span>}
'@ 'the sidebar cost cell'
}

if (-not $cssInstalled) {
  $css = Replace-Once $css @'
.dot {
'@ @'
.cost {
  flex: none;
  margin-right: 12px;
  font-size: 12px;
  line-height: 20px;
  color: #4176e6;
  font-variant-numeric: tabular-nums;
}

.dot {
'@ 'the sidebar cost style'

  $css = Replace-Once $css @'
.sessionRow:hover .time,
.sessionRow.menuOpen .time {
'@ @'
.sessionRow:hover .time,
.sessionRow.menuOpen .time,
.sessionRow:hover .cost,
.sessionRow.menuOpen .cost {
'@ 'the sidebar cost hover behavior'
}

# Validate all replacements before creating backups or writing any target file.
# Fixed relative paths keep this compatible with Windows PowerShell 5.1.
$backupRoot = Join-Path $root ('.dsh-damage-pulse-backups\sidebar-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
foreach ($target in $targets) {
  $backup = Join-Path $backupRoot $target.RelativePath
  $parent = Split-Path -Parent $backup
  New-Item -ItemType Directory -Path $parent -Force | Out-Null
  Copy-Item -LiteralPath $target.Path -Destination $backup
}

Write-Utf8File $treePath ($tree.Replace("`n", [Environment]::NewLine))
Write-Utf8File $rowsPath ($rows.Replace("`n", [Environment]::NewLine))
Write-Utf8File $cssPath ($css.Replace("`n", [Environment]::NewLine))

Write-Host 'dsh-damage-pulse: sidebar cost integration installed.'
Write-Host "Original files backed up to: $backupRoot"
Write-Host 'Next: run corepack pnpm --dir packages/client/ui-workspace exec tsdown, then restart dsh web.'
