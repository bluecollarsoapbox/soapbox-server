$stories = 1..5 | ForEach-Object { "D:\Soapbox App\Stories\Story$($_)\metadata.json" }
$now = Get-Date
foreach ($m in $stories) {
  if (Test-Path $m) {
    (Get-Item $m).LastWriteTime = $now
    Write-Host "Touched $m"
  }
}
