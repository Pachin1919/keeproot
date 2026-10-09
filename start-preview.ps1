[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$InstallRoot,
  [string]$NodePath = 'node.exe',
  [string]$PythonPath,
  [switch]$Install,
  [switch]$NewSample,
  [string]$ResumeId,
  [switch]$NoServe
)

$ErrorActionPreference = 'Stop'
$previewRoot = [IO.Path]::GetFullPath($InstallRoot)
$previewNode = (Get-Command -Name $NodePath -ErrorAction Stop).Source
$previewSkill = Join-Path $previewRoot 'skill'
$previewInstaller = Join-Path $PSScriptRoot 'install-atlas.ps1'
$previewManager = Join-Path $PSScriptRoot 'scripts/runtime-manager.js'
$previewDemo = Join-Path $PSScriptRoot 'scripts/demo.js'

if ($Install) {
  if (-not $PythonPath) { throw 'First installation requires -PythonPath with a trusted Python 3.11+ executable.' }
  $previewOperation = if (Test-Path -LiteralPath (Join-Path $previewRoot 'atlas-install.json')) { 'upgrade' } else { 'install' }
  & $previewInstaller -Command $previewOperation -InstallRoot $previewRoot -SkillRoot $previewSkill -NodePath $previewNode -DesktopPythonPath $PythonPath -NoStartMenuShortcut
  if ($LASTEXITCODE -ne 0) { throw 'Preview installation failed. The existing installer retained its failure details.' }
}

$previewLocationText = & $previewNode $previewManager locate --install-root $previewRoot
$previewLocationExit = $LASTEXITCODE
try { $previewLocation = ($previewLocationText -join "`n") | ConvertFrom-Json }
catch { throw "Preview Runtime location returned invalid JSON (exit $previewLocationExit). Inspect the Runtime manager output before reopening." }
if ($previewLocationExit -ne 0 -or $previewLocation.status -ne 'ready') {
  $previewReason = if ($previewLocation.message) { $previewLocation.message } else { "Runtime locate failed: $($previewLocation.status)." }
  $previewNext = if ($previewLocation.next_step) { $previewLocation.next_step } else { 'Inspect the Runtime manager failure before reopening.' }
  throw "Preview Runtime is unavailable. $previewReason Next: $previewNext"
}

# This pointer remembers this launcher’s fictional sample; it is not Project or Work state.
$previewPointer = Join-Path $previewRoot 'state/preview-demo.id'
if (Test-Path -LiteralPath $previewPointer) {
  $previewPointerItem = Get-Item -LiteralPath $previewPointer
  if ($previewPointerItem.PSIsContainer -or ($previewPointerItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $previewPointerItem.Length -gt 80) { throw 'Preview sample pointer must be a small regular file.' }
}
if (-not $ResumeId -and -not $NewSample -and (Test-Path -LiteralPath $previewPointer)) {
  $ResumeId = (Get-Content -LiteralPath $previewPointer -Raw).Trim()
}
if (-not $ResumeId -or $NewSample) {
  $previewSampleText = & $previewNode $previewDemo --install-root $previewRoot
  if ($LASTEXITCODE -ne 0) { throw 'Fictional sample preparation failed; its existing manifest was retained.' }
  $previewSample = ($previewSampleText -join "`n") | ConvertFrom-Json
  $ResumeId = $previewSample.demo_id
  if ($ResumeId -notmatch '^[a-fA-F0-9-]{36}$') { throw 'Sample preparation did not return a demo identity.' }
  # Reuse the existing preferences writer's exclusive temporary + rename pattern.
  # Replacing the directory entry preserves a hard-linked file's other targets.
  $previewPointerWriter = @'
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const [file, id] = process.argv.slice(2);
const temporary = path.join(path.dirname(file), '.preview-' + crypto.randomUUID() + '.tmp');
fs.writeFileSync(temporary, id + '\n', {flag: 'wx', encoding: 'utf8'});
try { fs.renameSync(temporary, file); }
catch (error) { fs.unlinkSync(temporary); throw error; }
'@
  $previewPointerWriter | & $previewNode - $previewPointer $ResumeId
  if ($LASTEXITCODE -ne 0) { throw 'Could not record the preview sample pointer. Existing sample data is retained.' }
}

Write-Output "Keeproot preview: sample $ResumeId"
if ($NoServe) { Write-Output 'Preparation finished. Run this script again with the same InstallRoot to open the same sample.'; exit 0 }
& $previewNode $previewDemo --install-root $previewRoot --resume $ResumeId --serve
exit $LASTEXITCODE
