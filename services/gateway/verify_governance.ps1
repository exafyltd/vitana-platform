$ErrorActionPreference = "Stop"

Write-Host "Starting Gateway Service..."
$process = Start-Process "npm.cmd" -ArgumentList "start" -PassThru -NoNewWindow -WorkingDirectory "c:\Users\dstev\vitana-platform\services\gateway"
Start-Sleep -Seconds 10

$baseUrl = "http://localhost:8080/api/v1/governance"
$endpoints = @(
    "categories",
    "rules",
    "violations",
    "enforcements",
    "evaluations",
    "feed",
    "summary"
)

try {
    foreach ($ep in $endpoints) {
        Write-Host "Testing GET $ep..."
        try {
            $response = Invoke-RestMethod -Uri "$baseUrl/$ep" -Method Get
            if ($response.ok -eq $true) {
                if ($ep -eq "summary") {
                     Write-Host "SUCCESS: $ep returned data"
                     Write-Host ($response.data | ConvertTo-Json -Depth 2)
                } else {
                     Write-Host "SUCCESS: $ep returned $($response.count) items"
                }
            } else {
                Write-Host "FAILURE: $ep returned ok=false"
            }
        } catch {
            if ($_.Exception.Response) {
                $statusCode = $_.Exception.Response.StatusCode.value__
                if ($statusCode -eq 503) {
                    Write-Host "SUCCESS: $ep returned 503 (Graceful Degradation)"
                } else {
                    Write-Host "FAILURE: $ep returned $statusCode"
                    # Write-Host $_.Exception.Message
                }
            } else {
                Write-Host "FAILURE: Could not connect to $ep"
                Write-Host $_.Exception.Message
            }
        }
    }
} finally {
    Write-Host "Stopping Gateway Service..."
    Stop-Process -Id $process.Id -Force
}
