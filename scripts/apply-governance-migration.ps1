$supabaseUrl = $env:SUPABASE_URL
$serviceRoleKey = $env:SUPABASE_SERVICE_ROLE_KEY

if (-not $supabaseUrl -or -not $serviceRoleKey) {
    Write-Error "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variables"
    exit 1
}

$migrationSql = Get-Content -Path "supabase/migrations/20251120000000_init_governance.sql" -Raw

$headers = @{
    "apikey" = $serviceRoleKey
    "Authorization" = "Bearer $serviceRoleKey"
    "Content-Type" = "application/json"
}

# Execute SQL via Supabase REST API
$body = @{
    query = $migrationSql
} | ConvertTo-Json

try {
    $response = Invoke-RestMethod -Uri "$supabaseUrl/rest/v1/rpc/exec_sql" -Method Post -Headers $headers -Body $body
    Write-Host "✅ Migration applied successfully"
    Write-Host $response
} catch {
    Write-Error "❌ Migration failed: $_"
    exit 1
}
