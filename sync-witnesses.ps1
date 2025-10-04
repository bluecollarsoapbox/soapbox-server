# ===========================================
#  Blue Collar Soapbox – Witness Sync Script
#  Pulls all witness originals from Render to local disk
# ===========================================

# ---- CONFIG ----
$BaseUrl = "https://soapbox-server.onrender.com"
$ApiKey  = "99dnfneeekdegnrJJSN3JdenrsdnJ"          #  <<== REPLACE WITH YOUR SOAPBOX_API_KEY
$LocalRoot = "D:\Soapbox App\soapbox-server\Stories"

# ---- HELPERS ----
function Ensure-Dir($path) {
    if (-not (Test-Path $path)) {
        New-Item -ItemType Directory -Path $path | Out-Null
    }
}

function Download-If-New($url, $dest) {
    if (Test-Path $dest) {
        # skip if file already exists and size matches
        $localSize = (Get-Item $dest).Length
        try {
            $req = [System.Net.WebRequest]::Create($url)
            $req.Method = "HEAD"
            $res = $req.GetResponse()
            $remoteSize = [int64]$res.Headers["Content-Length"]
            $res.Close()
            if ($remoteSize -eq $localSize) { return }
        } catch {}
    }

    Write-Host "Downloading $url -> $dest"
    Invoke-WebRequest -Uri $url -OutFile $dest -UseBasicParsing
}

# ---- MAIN ----
Write-Host "Fetching witness index..." -ForegroundColor Cyan
$headers = @{ "x-soapbox-key" = $ApiKey }

try {
    $resp = Invoke-RestMethod -Uri "$BaseUrl/admin/witness-index" -Headers $headers -Method GET
} catch {
    Write-Host "❌ Failed to reach server: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}

if (-not $resp.ok) {
    Write-Host "❌ Server returned error: $($resp.error)" -ForegroundColor Red
    exit 1
}

foreach ($story in $resp.stories) {
    $storyId = $story.storyId
    $files   = $story.files

    $targetDir = Join-Path $LocalRoot "$storyId\witnesses\originals"
    Ensure-Dir $targetDir

    foreach ($file in $files) {
        $url  = "$BaseUrl$($file.url)"
        $dest = Join-Path $targetDir $file.file
        Download-If-New $url $dest
    }
}

Write-Host "`n✅ Witness sync complete!" -ForegroundColor Green
