# Stops both EdgeMind device processes. Pass -All to also stop a native Qdrant server.
param([switch]$All)
$ports = @(8101, 8102); if ($All) { $ports += 6333 }
foreach ($port in $ports) {
  Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
    ForEach-Object { $p = Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue
      if ($p -and $p.ProcessName -in @('python', 'qdrant')) { Stop-Process -Id $p.Id -Force } }
}
# A device whose listening socket died no longer owns its port, so also match `python -m edge` directly.
Get-CimInstance Win32_Process -Filter "Name='python.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -match '-m edge\s*$' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
