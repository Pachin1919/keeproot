[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$CandidateFile,

  [Parameter(Mandatory = $true)]
  [string]$Root,

  [Parameter(Mandatory = $true)]
  [string]$Target,

  [ValidateSet('human_submitted', 'human_written', 'agent_generated', 'download')]
  [string]$Origin = 'human_submitted',

  [string]$Kind,
  [string]$ProjectId,
  [string]$ProjectName,
  [string]$ProjectPath,
  [switch]$CreateProjectIfMissing,

  [Parameter(Mandatory = $true)]
  [string]$Intent,

  [Parameter(Mandatory = $true)]
  [string]$Reason,

  [string]$Agent = 'Codex',
  [string]$Model = 'unknown',
  [string]$Tool = 'codex',
  [string]$ClientRunId = "attachment-intake-$([Guid]::NewGuid().ToString('N'))",
  [string]$InstallRoot = $(if ($env:ATLAS_HOME) { $env:ATLAS_HOME } else { Join-Path $env:LOCALAPPDATA 'Atlas' })
)

$ErrorActionPreference = 'Stop'
$script:AtlasCalls = 0
$utf8 = [Text.UTF8Encoding]::new($false)
[Console]::InputEncoding = $utf8
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8

function Write-CompactJson {
  param([Parameter(Mandatory = $true)]$Value)
  $Value | ConvertTo-Json -Depth 10 -Compress
}

function Invoke-AtlasJson {
  param(
    [Parameter(Mandatory = $true)]
    [string[]]$Arguments,
    [int]$TimeoutMilliseconds = 120000
  )

  $script:AtlasCalls += 1
  $startInfo = [Diagnostics.ProcessStartInfo]::new()
  $startInfo.FileName = $script:NodePath
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  $startInfo.StandardOutputEncoding = $utf8
  $startInfo.StandardErrorEncoding = $utf8
  $startInfo.Environment['ATLAS_HOME'] = $env:ATLAS_HOME
  $startInfo.Environment['ATLAS_STATE_DIR'] = $env:ATLAS_STATE_DIR
  foreach ($argument in (@($script:NodeArgs) + @($script:CliPath) + @($Arguments))) {
    $startInfo.ArgumentList.Add([string]$argument)
  }
  $process = [Diagnostics.Process]::Start($startInfo)
  $stdoutTask = $process.StandardOutput.ReadToEndAsync()
  $stderrTask = $process.StandardError.ReadToEndAsync()
  if (-not $process.WaitForExit($TimeoutMilliseconds)) {
    $process.Kill($true)
    throw "Atlas command timed out after $TimeoutMilliseconds ms: $($Arguments -join ' ')"
  }
  $raw = $stdoutTask.GetAwaiter().GetResult()
  $stderr = $stderrTask.GetAwaiter().GetResult()
  $exitCode = $process.ExitCode
  if (-not [string]::IsNullOrWhiteSpace($stderr)) {
    throw "Atlas wrote to stderr (exit $exitCode): $stderr"
  }
  try {
    $envelope = $raw | ConvertFrom-Json
  } catch {
    throw "Atlas returned non-JSON output (exit $exitCode): $raw"
  }
  if ($exitCode -ne 0 -or $envelope.protocol_version -ne 'atlas-cli.v1' -or $envelope.ok -ne $true) {
    throw "Atlas command failed (exit $exitCode): $raw"
  }
  return $envelope
}

try {
  $candidate = (Resolve-Path -LiteralPath $CandidateFile).Path
  $rootPath = (Resolve-Path -LiteralPath $Root).Path
  if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) {
    throw "Attachment Candidate is not a regular file: $candidate"
  }
  if (-not (Test-Path -LiteralPath $rootPath -PathType Container)) {
    throw "Intake root is not a directory: $rootPath"
  }

  $locator = Join-Path $PSScriptRoot 'locate-atlas.ps1'
  $located = & $locator -InstallRoot $InstallRoot | ConvertFrom-Json
  if ($located.status -ne 'ready') {
    throw "Atlas Runtime is not ready: $($located.status)"
  }
  $env:ATLAS_HOME = $located.install_root
  $env:ATLAS_STATE_DIR = $located.state_path
  $script:NodePath = $located.node_path
  $script:NodeArgs = @($located.node_args)
  $script:CliPath = $located.cli_path

  $manifest = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $InstallRoot 'atlas-install.json') | ConvertFrom-Json

  $projectCreated = $false
  if (-not $ProjectId) {
    if (-not $ProjectName -or -not $ProjectPath) {
      throw 'Supply ProjectId, or supply both ProjectName and ProjectPath.'
    }
    $projects = (Invoke-AtlasJson @('project', 'list', '--json')).data
    $matches = @($projects | Where-Object {
      $_.name -eq $ProjectName -and $_.current_path -eq $ProjectPath
    })
    if ($matches.Count -gt 1) {
      throw "More than one active Project matches $ProjectName at $ProjectPath."
    }
    if ($matches.Count -eq 1) {
      $ProjectId = $matches[0].id
    } elseif ($CreateProjectIfMissing) {
      $created = Invoke-AtlasJson @(
        'project', 'create',
        '--name', $ProjectName,
        '--path', $ProjectPath,
        '--json'
      )
      $ProjectId = $created.data.project_id
      $projectCreated = $true
    } else {
      throw "Project is not registered: $ProjectName at $ProjectPath."
    }
  }

  $saveArguments = @(
    'save', 'prepare',
    '--root', $rootPath,
    '--candidate-file', $candidate,
    '--origin', $Origin,
    '--project', $ProjectId,
    '--target', $Target,
    '--intent', $Intent,
    '--channel', 'host',
    '--request-key', $ClientRunId,
    '--actor', 'agent',
    '--agent', $Agent,
    '--model', $Model,
    '--tool', $Tool,
    '--client-run-id', $ClientRunId
  )
  if ($Kind) { $saveArguments += @('--kind', $Kind) }
  $saveArguments += '--json'
  $prepared = (Invoke-AtlasJson $saveArguments).data
  if ($prepared.status -ne 'prepared' -and $prepared.status -ne 'executed') {
    throw "Atlas did not prepare the attachment Save: $($prepared.status)"
  }
  $item = if ($prepared.status -eq 'executed') {
    $prepared
  } else {
    (Invoke-AtlasJson @('save', 'execute', $prepared.save_id, '--reason', $Reason, '--json')).data
  }
  $sourceHash = (Get-FileHash -LiteralPath $candidate -Algorithm SHA256).Hash.ToLowerInvariant()
  $targetRelative = $item.target.relative_path
  $targetPath = [IO.Path]::GetFullPath((Join-Path $rootPath $targetRelative))
  if (-not (Test-Path -LiteralPath $targetPath -PathType Leaf)) {
    throw "Atlas reported execution but the target is absent: $targetPath"
  }
  $targetHash = (Get-FileHash -LiteralPath $targetPath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($targetHash -ne $sourceHash) {
    throw "Atlas target Hash does not match the attachment Candidate: $targetPath"
  }

  Write-CompactJson ([ordered]@{
    schema = 'atlas-skill-intake-file.v1'
    ok = $true
    status = 'executed'
    executed = $true
    project = [ordered]@{
      id = $ProjectId
      name = $item.project.name
      path = $ProjectPath
      created = $projectCreated
    }
    classification = [ordered]@{ origin = $Origin; kind = $(if ($Kind) { $Kind } else { $null }) }
    run_id = $item.run_id
    target = $targetRelative
    bytes = (Get-Item -LiteralPath $targetPath).Length
    sha256 = $targetHash
    hash_match = $true
    verified = $item.verified
    rollback_ready = $item.undo_available
    atlas_version = $manifest.atlas_version
    atlas_calls = $script:AtlasCalls
    runtime_processes = 2
    content_body_reads = 0
    model_visible_body_bytes = 0
    ppt_body_reads = 0
  })
} catch {
  Write-CompactJson ([ordered]@{
    schema = 'atlas-skill-intake-file.v1'
    ok = $false
    status = 'failed'
    error = $_.Exception.Message
    atlas_calls = $script:AtlasCalls
    content_body_reads = 0
    model_visible_body_bytes = 0
  })
  exit 1
}
