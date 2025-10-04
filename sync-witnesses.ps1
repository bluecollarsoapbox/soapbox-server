# ================== CONFIG (edit these 3) ==================
$BASE = "https://soapbox-server.onrender.com"   # <-- your server base URL
$ADMIN_KEY = "99dnfneeekdegnrJJSN3JdenrsdnJ"                          # <-- your SOAPBOX_API_KEY
$DEST = "D:\Soapbox App\soapbox-server\Stories"  # <-- where to save on PC
$DOWNLOAD_POSTED_TOO = $true                     # set $false to skip watermarked copies
# ===========================================================

# Ensure destination exists
if (!(Test-Path $DEST)) { New-Item -ItemType Directory -Path $DEST | Out-Null }

# Helper: safe join for Windows paths
function Join-Path2($a,$b){ return [System.IO.Path]::Combine($a,$b) }

# 1) Get witness index (admin-protected)
$indexUrl = "$BASE/admin/witness-index"
try {
  $resp = Invoke-RestMethod -Method GET -Uri $indexUrl -Headers @{ "x-soapbox-key" = $ADMIN_KEY }
} catch {
  Write-Host "ERROR: Failed to fetch $indexUrl" -ForegroundColor Red
  Write-Host $_.Exception.Message -ForegroundColor Red
  exit 1
}

if (-not $resp.ok) {
  Write-Host "Server responded with error: $($resp.error)" -ForegroundColor Red
  exit 1
}

# 2) For each story, download originals (and optionally posted)
#    The index returns only originals by default. We’ll also try posted via predictable paths.
$stories = $resp.stories
if (-not $stories -or $stories.Count -eq 0) {
  Write-Host "No witness originals found on server." -ForegroundColor Yellow
  exit 0
}

$downloaded = 0
$skipped = 0
$failed = 0

foreach ($s in $stories) {
  $storyId = $s.storyId
  $storyRoot = Join-Path2 $DEST $storyId
  $origDir = Join-Path2 $storyRoot "witnesses\originals"
  $postedDir = Join-Path2 $storyRoot "witnesses\posted"
  if (!(Test-Path $origDir))   { New-Item -ItemType Directory -Path $origDir -Force | Out-Null }
  if ($DOWNLOAD_POSTED_TOO -and !(Test-Path $postedDir)) { New-Item -ItemType Directory -Path $postedDir -Force | Out-Null }

  # Originals listed in the index
  foreach ($f in $s.files) {
    $name = $f.file
    $url  = "$BASE$f.url"      # url already starts with /static/...
    $destFile = Join-Path2 $origDir $name

    if (Test-Path $destFile) {
      $skipped++
      continue
    }

    try {
      Invoke-WebRequest -Uri $url -OutFile $destFile
      $downloaded++
      Write-Host "Downloaded: $storyId / originals / $name"
    } catch {
      $failed++
      Write-Host "FAILED: $storyId / originals / $name" -ForegroundColor Red
    }
  }

  if ($DOWNLOAD_POSTED_TOO) {
    # Try to mirror posted files by probing the server filesystem pattern.
    # We don't have a posted list in /admin/witness-index, so we reconstruct names (same timestamp but .mp4).
    # Grab timestamps from original filenames (prefix before first dot).
    foreach ($f in $s.files) {
      # compute the watermarked filename (server saves posted as {timestamp}.mp4)
      $timestamp = ($f.file -split '\.')[0]
      $wmName = "$timestamp.mp4"
      $wmUrl  = "$BASE/static/Stories/$([uri]::EscapeDataString($storyId))/witnesses/posted/$([uri]::EscapeDataString($wmName))"
      $wmDest = Join-Path2 $postedDir $wmName

      if (Test-Path $wmDest) { $skipped++; continue }

      try {
        # We first HEAD to see if it exists; if 404, skip quietly
        $head = Invoke-WebRequest -Method Head -Uri $wmUrl -ErrorAction Stop
        Invoke-WebRequest -Uri $wmUrl -OutFile $wmDest
        $downloaded++
        Write-Host "Downloaded: $storyId / posted / $wmName"
      } catch {
        # ignore if not found; only count as failed for other errors
        if ($_.Exception.Response.StatusCode.value__ -ne 404) {
          $failed++
          Write-Host "FAILED (posted): $storyId / $wmName" -ForegroundColor DarkYellow
        }
      }
    }
  }
}

Write-Host ""
Write-Host "=== Sync complete ==="
Write-Host "Downloaded: $downloaded"
Write-Host "Skipped (already had): $skipped"
Write-Host "Failed: $failed"
