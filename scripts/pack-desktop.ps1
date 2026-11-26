#requires -Version 7
[CmdletBinding()]
param(
  [switch]$SkipBuild,
  [switch]$Install,
  [switch]$Publish,
  [string]$GitHubToken,
  [string]$OutputDir = 'Releases',
  [string]$ReleaseNotes,
  [string]$Channel,
  [switch]$PreRelease,
  [switch]$NoPortable,
  [switch]$NoDelta,
  [switch]$Clean
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

$tauriConf = Get-Content -LiteralPath (Join-Path $root 'src-tauri\tauri.conf.json') -Raw | ConvertFrom-Json
if ([string]$tauriConf.version -cne $version) {
  throw "package.json version ($version) does not match src-tauri/tauri.conf.json version ($($tauriConf.version))."
}

$npm = (Get-Command npm.cmd -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Source)
if (-not $npm) { $npm = (Get-Command npm -ErrorAction Stop).Source }
$vpk = (Get-Command vpk -ErrorAction Stop).Source
$setupCompiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $setupCompiler -PathType Leaf)) {
  throw 'The Windows .NET Framework C# compiler is required to build Axiom Setup.'
}

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
  Copy-Item -LiteralPath (Join-Path $root 'integrations') -Destination (Join-Path $stageDir 'integrations') -Recurse -Force

  $stageScripts = Join-Path $stageDir 'scripts'
  New-Item -ItemType Directory -Path $stageScripts -Force | Out-Null
  foreach ($scriptName in @('start.ps1', 'setup-embeddings.mjs')) {
    $srcScript = Join-Path $root "scripts\$scriptName"
    if (Test-Path -LiteralPath $srcScript -PathType Leaf) {
      Copy-Item -LiteralPath $srcScript -Destination (Join-Path $stageScripts $scriptName) -Force
    }
  }

  Write-Output 'Installing production Node dependencies in staging directory...'
  & $npm ci --omit=dev --ignore-scripts --prefix $stageDir
  if ($LASTEXITCODE -ne 0) { throw "Staged npm ci failed with exit code $LASTEXITCODE" }
  Remove-Item -LiteralPath (Join-Path $stageDir 'package-lock.json') -Force -ErrorAction SilentlyContinue

  $resolvedOutDir = if ([IO.Path]::IsPathRooted($OutputDir)) { $OutputDir } else { Join-Path $root $OutputDir }
  New-Item -ItemType Directory -Path $resolvedOutDir -Force | Out-Null

  $shouldClean = [bool]$Clean
  if (-not $shouldClean -and $NoDelta) {
    $releaseManifests = Get-ChildItem -LiteralPath $resolvedOutDir -Filter 'releases*.json' -File -ErrorAction SilentlyContinue
    foreach ($manifestFile in $releaseManifests) {
      try {
        $manifestJson = Get-Content -LiteralPath $manifestFile.FullName -Raw | ConvertFrom-Json
        if ($manifestJson.Assets | Where-Object { $_.Version -eq $version }) {
          $shouldClean = $true
          break
        }
      } catch {}
    }
  }
  if ($shouldClean) {
    Write-Output "Cleaning stale Velopack release artifacts in $resolvedOutDir..."
    Get-ChildItem -LiteralPath $resolvedOutDir -Force -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force
  }

  if (-not $NoDelta -and $token) {
    Write-Output 'Hydrating previous GitHub release assets for delta generation...'
    $downloadArgs = @(
      'download', 'github',
      '--repoUrl', 'https://github.com/AlexMollard/Axiom',
      '--token', $token,
      '--outputDir', $resolvedOutDir
    )
    if ($Channel) { $downloadArgs += @('--channel', $Channel) }
    if ($PreRelease) { $downloadArgs += '--pre' }
    & $vpk @downloadArgs 2>$null | Out-Null
  }

  $iconPath = Join-Path $root 'src-tauri\icons\icon.ico'
  Write-Output "Packing AxiomDesktop v$version with Velopack..."
  $packArgs = @(
    'pack',
    '--packId', 'AxiomDesktop',
    '--packTitle', 'Axiom',
    '--packAuthors', 'Alex Mollard',
    '--packVersion', $version,
    '--packDir', $stageDir,
    '--mainExe', 'axiom.exe',
    '--icon', $iconPath,
    '--splashImage', (Join-Path $root 'src-tauri\icons\setup-splash.png'),
    '--splashProgressColor', '#D39476',
    '--outputDir', $resolvedOutDir,
    '--runtime', 'win-x64',
    '--aumid', 'com.alexmollard.axiom',
    '--framework', 'webview2',
    '--shortcuts', 'Desktop,StartMenuRoot'
  )
  if ($ReleaseNotes) { $packArgs += @('--releaseNotes', $ReleaseNotes) }
  if ($Channel) { $packArgs += @('--channel', $Channel) }
  if ($NoPortable) { $packArgs += '--noPortable' }

  & $vpk @packArgs
  if ($LASTEXITCODE -ne 0) { throw "vpk pack failed with exit code $LASTEXITCODE" }

  $setupExe = Join-Path $resolvedOutDir 'AxiomDesktop-win-Setup.exe'
  $setupVersionFile = Join-Path $stageDir 'SetupVersion.cs'
  $themedSetup = Join-Path $resolvedOutDir ".axiom-setup-$([guid]::NewGuid()).exe"
  [IO.File]::WriteAllText($setupVersionFile, "[assembly: System.Reflection.AssemblyVersion(`"$version`")]")
  try {
    & $setupCompiler /nologo /target:winexe /optimize+ /codepage:65001 "/out:$themedSetup" "/win32icon:$iconPath" `
      "/resource:$setupExe,Axiom.VelopackSetup" "/resource:$root\src-tauri\icons\128x128.png,Axiom.Emblem" `
      /reference:System.Drawing.dll /reference:System.Windows.Forms.dll (Join-Path $PSScriptRoot 'AxiomSetup.cs') $setupVersionFile
    if ($LASTEXITCODE -ne 0) { throw "Axiom Setup launcher build failed with exit code $LASTEXITCODE" }
    [IO.File]::Move($themedSetup, $setupExe, $true)
  } finally {
    [IO.File]::Delete($themedSetup)
  }
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
    if (-not $token) {
      throw 'No GitHub token found. Pass -GitHubToken or authenticate with gh auth login.'
    }
    Write-Output "Uploading AxiomDesktop v$version to GitHub Releases..."
    $uploadArgs = @(
      'upload', 'github',
      '--outputDir', $resolvedOutDir,
      '--repoUrl', 'https://github.com/AlexMollard/Axiom',
      '--token', $token,
      '--tag', "v$version",
      '--releaseName', "Axiom v$version",
      '--publish'
    )
    if ($Channel) { $uploadArgs += @('--channel', $Channel) }
    if ($PreRelease) { $uploadArgs += '--pre' }
    & $vpk @uploadArgs
    if ($LASTEXITCODE -ne 0) { throw "vpk upload github failed with exit code $LASTEXITCODE" }
    Write-Output "Published Axiom v$version to GitHub Releases."
  }
} finally {
  Pop-Location
}
