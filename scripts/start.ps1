# Starts the full two-device EdgeMind demo on one machine.
#   Qdrant Server  -> http://localhost:6333   (docker)
#   Laptop         -> http://localhost:8101   (device_a, desktop UI)
#   Mobile         -> http://localhost:8102   (device_b, mobile UI)
param([switch]$Rebuild, [switch]$Fresh)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

if (-not (Test-Path .venv)) {
  python -m venv .venv
  .\.venv\Scripts\python -m pip install -q -r requirements.txt
}
if ($Rebuild -or -not (Test-Path web\dist\index.html)) {
  Push-Location web; if (-not (Test-Path node_modules)) { npm install }; npm run build; Pop-Location
}

& "$PSScriptRoot\stop.ps1"
if ($Fresh) {
  Remove-Item -Recurse -Force data\device_a, data\device_b -ErrorAction SilentlyContinue
  try { Invoke-RestMethod -Method Delete http://127.0.0.1:6333/collections/edgemind_shared | Out-Null } catch {}
}

New-Item -ItemType Directory -Force data | Out-Null

# Central Qdrant Server: reuse one if already up, else Docker, else the native binary.
function Test-Qdrant { try { Invoke-RestMethod http://127.0.0.1:6333/healthz -TimeoutSec 2 | Out-Null; $true } catch { $false } }
if (-not (Test-Qdrant)) {
  # With ErrorActionPreference=Stop, docker's "daemon not running" stderr would abort the script
  # instead of falling back to the native binary, so probe it inside try/catch.
  $dockerUp = $false
  try { docker info *> $null; $dockerUp = ($LASTEXITCODE -eq 0) } catch { $dockerUp = $false }
  $global:LASTEXITCODE = 0  # a failed probe must not become the script's exit code
  if ($dockerUp) {
    docker compose up -d | Out-Null
  } else {
    $exe = "$root\tools\qdrant\qdrant.exe"
    if (-not (Test-Path $exe)) {
      Write-Host "  Docker not running - downloading native Qdrant server..."
      New-Item -ItemType Directory -Force tools\qdrant | Out-Null
      Invoke-WebRequest -UseBasicParsing -OutFile tools\qdrant.zip `
        https://github.com/qdrant/qdrant/releases/download/v1.19.1/qdrant-x86_64-pc-windows-msvc.zip
      Expand-Archive -Force tools\qdrant.zip tools\qdrant; Remove-Item tools\qdrant.zip
    }
    New-Item -ItemType Directory -Force data\qdrant_native | Out-Null
    $env:QDRANT__STORAGE__STORAGE_PATH = "$root\data\qdrant_native\storage"
    $env:QDRANT__TELEMETRY_DISABLED = "true"
    Start-Process -WindowStyle Hidden -FilePath $exe -WorkingDirectory data\qdrant_native `
      -RedirectStandardOutput data\qdrant.out.log -RedirectStandardError data\qdrant.err.log
  }
  for ($i = 0; $i -lt 30 -and -not (Test-Qdrant); $i++) { Start-Sleep -Milliseconds 500 }
}
Write-Host ("  Qdrant Server " + $(if (Test-Qdrant) { "ready  ->  http://localhost:6333" } else { "NOT reachable (devices will run offline)" }))

# Every device in deploy/demo.json (Laptop, Mobile and the demo accounts) runs inside ONE process
# (edge/host.py): the libraries and search model load once. Each device keeps its own port and data.
# The sign-in address for every account is :8100.
Start-Process -WindowStyle Hidden -FilePath "$root\.venv\Scripts\python.exe" -ArgumentList "-m", "edge.host" `
  -RedirectStandardOutput "data\host.out.log" -RedirectStandardError "data\host.err.log"

$devices = (Get-Content -Raw deploy\demo.json | ConvertFrom-Json).devices
$ports = @($devices | ForEach-Object { @{ name = $_.name; port = $_.port } }) + @(@{ name = "Sign in (all accounts)"; port = 8100 })
foreach ($d in $ports) {
  $up = $false
  for ($i = 0; $i -lt 120 -and -not $up; $i++) {
    try { Invoke-RestMethod "http://127.0.0.1:$($d.port)/api/session" -TimeoutSec 2 | Out-Null; $up = $true }
    catch { Start-Sleep -Milliseconds 500 }
  }
  if ($up) { Write-Host "  $($d.name) ready  ->  http://localhost:$($d.port)" }
  else { Write-Host "  $($d.name) failed to start; see data\host.err.log" }
}
