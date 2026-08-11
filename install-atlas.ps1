[CmdletBinding()]
param(
  [ValidateSet('install', 'locate', 'upgrade', 'uninstall', 'hook-install', 'hook-status', 'hook-remove')]
  [string]$Command = 'install',
  [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA 'Atlas'),
  [string]$SkillRoot = (Join-Path ([Environment]::GetFolderPath('UserProfile')) '.codex\skills\atlas-file-governance'),
  [string]$CodexHome = (Join-Path ([Environment]::GetFolderPath('UserProfile')) '.codex'),
  [string]$ProjectRoot,
  [string]$NodePath = 'node.exe',
  [string[]]$LibraryRoot = @(),
  [switch]$NoStartMenuShortcut
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$manager = Join-Path $projectRoot 'scripts\runtime-manager.js'

try {
  $nodeCommand = Get-Command -Name $NodePath -ErrorAction Stop
  $nodeExecutable = $nodeCommand.Source
  $versionText = & $nodeExecutable --version
  if ($LASTEXITCODE -ne 0 -or $versionText -notmatch '^v(?<major>\d+)\.') {
    throw 'Unable to determine the Node.js version.'
  }
  if ([int]$Matches.major -lt 24) {
    throw "Atlas requires Node.js 24 or newer; found $versionText."
  }
} catch {
  [Console]::Error.WriteLine('Atlas Runtime was not installed. Install Node.js 24+ or pass -NodePath to a local portable Node executable.')
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}

$arguments = @($manager, $Command, '--install-root', $InstallRoot, '--skill-root', $SkillRoot, '--node', $nodeExecutable, '--codex-home', $CodexHome)
if ($ProjectRoot) {
  $arguments += @('--project-root', $ProjectRoot)
}
foreach ($root in $LibraryRoot) {
  $arguments += @('--library-root', $root)
}

& $nodeExecutable @arguments
$runtimeExitCode = $LASTEXITCODE

if ($runtimeExitCode -eq 0 -and -not $NoStartMenuShortcut) {
  $programs = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
  $shortcutPath = Join-Path $programs 'Atlas UI.lnk'
  if ($Command -in @('install', 'upgrade')) {
    try {
      $shell = New-Object -ComObject WScript.Shell
      $shortcut = $shell.CreateShortcut($shortcutPath)
      $shortcut.TargetPath = Join-Path $InstallRoot 'atlas-ui.cmd'
      $shortcut.WorkingDirectory = [Environment]::GetFolderPath('UserProfile')
      $shortcut.Description = 'Open the local Atlas Workspace UI'
      $shortcut.WindowStyle = 7
      $shortcut.Save()
    } catch {
      Write-Warning "Atlas Runtime was installed, but the Start menu shortcut could not be created: $($_.Exception.Message)"
    }
  } elseif ($Command -eq 'uninstall') {
    Remove-Item -LiteralPath $shortcutPath -Force -ErrorAction SilentlyContinue
  }
}

exit $runtimeExitCode
