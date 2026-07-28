[CmdletBinding()]
param(
  [string]$InstallRoot = $(if ($env:ATLAS_HOME) { $env:ATLAS_HOME } else { Join-Path $env:LOCALAPPDATA 'Atlas' })
)

$manifestPath = Join-Path $InstallRoot 'atlas-install.json'
if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
  @{ status = 'runtime_required'; install_root = $InstallRoot } | ConvertTo-Json -Compress
  exit 2
}

try {
  $manifest = Get-Content -Raw -Encoding UTF8 -LiteralPath $manifestPath | ConvertFrom-Json
  if ($manifest.install_format -ne 'atlas-runtime-install.v1') {
    throw 'Unrecognized Atlas installation manifest.'
  }
  if ($manifest.protocol_version -ne 'atlas-cli.v1') {
    @{
      status = 'incompatible_protocol'
      expected_protocol = 'atlas-cli.v1'
      received_protocol = $manifest.protocol_version
    } | ConvertTo-Json -Compress
    exit 3
  }
  $cli = Join-Path $manifest.runtime_path 'bin\atlas.js'
  if (-not (Test-Path -LiteralPath $manifest.node_path -PathType Leaf) -or -not (Test-Path -LiteralPath $cli -PathType Leaf)) {
    throw 'Atlas Runtime files are incomplete.'
  }
  @{
    status = 'ready'
    install_root = $InstallRoot
    node_path = $manifest.node_path
    node_args = @($manifest.node_args)
    cli_path = $cli
    state_path = $manifest.state_path
    protocol_version = $manifest.protocol_version
  } | ConvertTo-Json -Compress
} catch {
  @{ status = 'invalid_installation'; message = $_.Exception.Message } | ConvertTo-Json -Compress
  exit 1
}
