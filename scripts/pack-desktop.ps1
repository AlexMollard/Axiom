#requires -Version 7
[CmdletBinding()]
param(
  [switch]$SkipBuild,
  [switch]$Install,
  [switch]$Publish,
  [string]$GitHubToken,
  [string]$OutputDir = 'Releases'
)
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$pkg = Get-Content -LiteralPath (Join-Path $root 'package.json') -Raw | ConvertFrom-Json
$version = [string]$pkg.version
if (-not $version) { throw 'Could not read version from package.json.' }

$cargoToml = Get-Content -LiteralPath (Join-Path $root 'src-tauri\Cargo.toml') -Raw
if ($cargoToml -notmatch "(?m)^version\s*=\s*""$([regex]::Escape($version))""") {
  throw "package.json version ($version) does not match src-tauri/Cargo.toml version."
}

$npm = (Get-Command npm.cmd -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Source)
if (-not $npm) { $npm = (Get-Command npm -ErrorAction Stop).Source }
$vpk = (Get-Command vpk -ErrorAction Stop).Source

Push-Location $root
try {
  if (-not $SkipBuild) {
    Write-Output 'Building Axiom frontend bundle...'
    & $npm run build
    if ($LASTEXITCODE -ne 0) { throw "Frontend build failed with exit code $LASTEXITCODE" }

    Write-Output 'Building Axiom desktop release binary...'
    & cargo build --release --manifest-path (Join-Path $root 'src-tauri\Cargo.toml')
    if ($LASTEXITCODE -ne 0) { throw "Cargo release build failed with exit code $LASTEXITCODE" }
  }

  $exePath = Join-Path $root 'src-tauri\target\release\axiom.exe'
  if (-not (Test-Path -LiteralPath $exePath -PathType Leaf)) {
    throw "Missing release executable at $exePath"
  }
  $distPath = Join-Path $root 'dist'
  if (-not (Test-Path -LiteralPath (Join-Path $distPath 'index.html') -PathType Leaf)) {
    throw "Missing frontend build at $distPath"
  }

  $stageDir = Join-Path $root '.state\velopack-stage'
  if (Test-Path -LiteralPath $stageDir) {
    Remove-Item -LiteralPath $stageDir -Recurse -Force
  }
  New-Item -ItemType Directory -Path $stageDir -Force | Out-Null

  Copy-Item -LiteralPath $exePath -Destination (Join-Path $stageDir 'axiom.exe') -Force
  Copy-Item -LiteralPath (Join-Path $root 'package.json') -Destination (Join-Path $stageDir 'package.json') -Force
  Copy-Item -LiteralPath (Join-Path $root 'package-lock.json') -Destination (Join-Path $stageDir 'package-lock.json') -Force
  Copy-Item -LiteralPath (Join-Path $root 'src') -Destination (Join-Path $stageDir 'src') -Recurse -Force
  Copy-Item -LiteralPath $distPath -Destination (Join-Path $stageDir 'dist') -Recurse -Force
  Copy-Item -LiteralPath (Join-Path $root 'scripts') -Destination (Join-Path $stageDir 'scripts') -Recurse -Force
  Copy-Item -LiteralPath (Join-Path $root 'integrations') -Destination (Join-Path $stageDir 'integrations') -Recurse -Force

  Write-Output 'Installing production Node dependencies in staging directory...'
  & $npm ci --omit=dev --ignore-scripts --prefix $stageDir
  if ($LASTEXITCODE -ne 0) { throw "Staged npm ci failed with exit code $LASTEXITCODE" }

  $resolvedOutDir = if ([IO.Path]::IsPathRooted($OutputDir)) { $OutputDir } else { Join-Path $root $OutputDir }
  New-Item -ItemType Directory -Path $resolvedOutDir -Force | Out-Null

  $iconPath = Join-Path $root 'src-tauri\icons\icon.ico'
  Write-Output "Packing AxiomDesktop v$version with Velopack..."
  & $vpk pack `
    --packId AxiomDesktop `
    --packTitle Axiom `
    --packAuthors 'Alex Mollard' `
    --packVersion $version `
    --packDir $stageDir `
    --mainExe axiom.exe `
    --icon $iconPath `
    --outputDir $resolvedOutDir `
    --shortcuts 'Desktop,StartMenuRoot'
  if ($LASTEXITCODE -ne 0) { throw "vpk pack failed with exit code $LASTEXITCODE" }

  $setupExe = Join-Path $resolvedOutDir 'AxiomDesktop-win-Setup.exe'
  Write-Output "Velopack release ready: $setupExe"

  if ($Install) {
    if (-not (Test-Path -LiteralPath $setupExe -PathType Leaf)) {
      throw "Missing setup executable at $setupExe"
    }
    Write-Output 'Installing AxiomDesktop silently...'
    $proc = Start-Process -FilePath $setupExe -ArgumentList '--silent' -Wait -PassThru
    if ($proc.ExitCode -ne 0) {
      throw "Setup installer exited with code $($proc.ExitCode)"
    }
    Write-Output "Installed AxiomDesktop into $env:LOCALAPPDATA\AxiomDesktop"
  }

  if ($Publish) {
    $token = $GitHubToken
    if (-not $token) { $token = $env:AXIOM_GITHUB_TOKEN }
    if (-not $token) { $token = $env:GITHUB_TOKEN }
    if (-not $token) { $token = $env:GH_TOKEN }
    if (-not $token) {
      $gh = Get-Command gh -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Source
      if ($gh) {
        $token = (& $gh auth token 2>$null | Out-String).Trim()
      }
    }
    if (-not $token) {
      throw 'No GitHub token found. Pass -GitHubToken or authenticate with gh auth login.'
    }
    Write-Output "Uploading AxiomDesktop v$version to GitHub Releases..."
    & $vpk upload github `
      --outputDir $resolvedOutDir `
      --repoUrl 'https://github.com/AlexMollard/Axiom' `
      --token $token `
      --tag "v$version" `
      --releaseName "Axiom v$version" `
      --publish
    if ($LASTEXITCODE -ne 0) { throw "vpk upload github failed with exit code $LASTEXITCODE" }
    Write-Output "Published Axiom v$version to GitHub Releases."
  }
} finally {
  Pop-Location
}
