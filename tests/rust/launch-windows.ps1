param(
  [Parameter(Mandatory=$true)][string]$Repository,
  [Parameter(Mandatory=$true)][string]$ExpectedSha
)
$ErrorActionPreference = 'Stop'
Set-Location $Repository
$actual = (& git rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or $actual -ne $ExpectedSha) { throw "Wrong launcher revision: $actual" }
$dirty = & git status --porcelain
if ($LASTEXITCODE -ne 0 -or $dirty) { throw 'Launcher checkout must be clean' }
& rustc --version
if ($LASTEXITCODE -ne 0) { throw 'Native Rust compiler unavailable' }
$env:CARGO_HOME = Join-Path $Repository 'target\launch-cargo-home'
$env:CARGO_TARGET_DIR = Join-Path $Repository 'target\launch-build'
$env:CARGO_BUILD_JOBS = '2'
& cargo test --locked --test rust_launch
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& cargo test --locked --release --test rust_launch
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& cargo clippy --locked --test rust_launch -- -D warnings
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
$actual = (& git rev-parse HEAD).Trim()
$dirty = & git status --porcelain
if ($LASTEXITCODE -ne 0 -or $actual -ne $ExpectedSha -or $dirty) { throw 'Launcher revision changed during validation' }
Write-Output "Native Windows launcher process tests passed at $actual (not GUI application acceptance)"
exit 0
