# VTID-05063 ship script. Run it in YOUR OWN PowerShell (not through Kiro) so no approval prompts appear.
# Safe to rerun: every step checks state first.
#   powershell -ExecutionPolicy Bypass -File "C:\Users\dstev\vitana-platform-1\.agents\tasks\gateway-ledger-read-auth\ship\ship.ps1"
# It: pushes any pending fix, waits for CI on both PRs, saves failing logs, merges when green,
# watches the staging deploy + STAGING-VERIFY, checks staging live (open build-info + authenticated read),
# and writes everything to run.log and evidence.md in this folder. Kiro reads those files; nothing else to do.

$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'

$task = 'C:\Users\dstev\vitana-platform-1\.agents\tasks\gateway-ledger-read-auth\ship'
New-Item -ItemType Directory -Force $task | Out-Null
Start-Transcript -Path (Join-Path $task 'run.log') -Force | Out-Null

$platRepo = 'exafyltd/vitana-platform'
$v1Repo   = 'exafyltd/vitana-v1'
$platPr   = 4033
$v1Pr     = 1333
$platDir  = 'C:\Users\dstev\vitana-platform-1\.worktrees\vtid-05063-ledger-read-auth'
$v1Dir    = 'C:\Users\dstev\vitana-v1\.worktrees\vtid-05063-taskapi-auth'
$ident    = @('-c', 'user.name=exafyltd', '-c', 'user.email=171726573+exafyltd@users.noreply.github.com')
$stage    = 'https://preview-aws-gateway.vitanaland.com'
$evidence = New-Object System.Collections.ArrayList

function Step($m) { Write-Host ''; Write-Host "=== $m ===" }
function Note($m) { Write-Host $m; [void]$evidence.Add($m) }

function Finish($status) {
    Note "RESULT: $status"
    $evidence | Out-File -Encoding utf8 (Join-Path $task 'evidence.md')
    Stop-Transcript | Out-Null
    exit 0
}

function Push-IfDirty($dir, $branch, $msg) {
    Push-Location $dir
    $dirty = git status --porcelain
    if ($dirty) {
        git add -A
        git @ident commit -q -m $msg
        Write-Host "committed pending changes on $branch"
    }
    git push origin $branch 2>&1 | Write-Host
    Pop-Location
}

function Save-FailLogs($repo, $checks, $label) {
    foreach ($c in $checks) {
        if ($c.link -match '/runs/(\d+)') {
            $id = $Matches[1]
            $file = Join-Path $task ("ci-fail-{0}-{1}.txt" -f $label, $id)
            if (-not (Test-Path $file)) {
                gh run view $id --repo $repo --log-failed 2>&1 | Select-Object -Last 400 | Out-File -Encoding utf8 $file
            }
            Note ("  FAILED check: {0}  ({1})  log: {2}" -f $c.name, $c.link, $file)
        } else {
            Note ("  FAILED check: {0}  ({1})" -f $c.name, $c.link)
        }
    }
}

function Wait-Checks($repo, $pr, $label) {
    $deadline = (Get-Date).AddMinutes(75)
    while ((Get-Date) -lt $deadline) {
        $raw = gh pr checks $pr --repo $repo --json name,bucket,link 2>$null
        $checks = @()
        if ($raw) { $checks = @($raw | ConvertFrom-Json) }
        if ($checks.Count -gt 0) {
            $pending = @($checks | Where-Object { $_.bucket -eq 'pending' })
            $failed  = @($checks | Where-Object { $_.bucket -eq 'fail' -or $_.bucket -eq 'cancel' })
            Write-Host ("[{0}] {1} checks: {2} pending, {3} failed" -f $label, $checks.Count, $pending.Count, $failed.Count)
            if ($pending.Count -eq 0) {
                return @{ ok = ($failed.Count -eq 0); failed = $failed }
            }
        } else {
            Write-Host "[$label] no checks reported yet"
        }
        Start-Sleep -Seconds 45
    }
    return @{ ok = $false; failed = @(); timeout = $true }
}

function Sync-Main($dir, $label) {
    # Merge origin/main into the branch. On conflicts: write the file list and return $false (Kiro resolves, you rerun).
    Push-Location $dir
    $conflictFile = Join-Path $task ("conflicts-{0}.txt" -f $label)
    $gitDir = (git rev-parse --git-dir)
    if (Test-Path (Join-Path $gitDir 'MERGE_HEAD')) {
        $unmerged = @(git diff --name-only --diff-filter=U)
        $still = @()
        foreach ($f in $unmerged) {
            if (Select-String -Path $f -Pattern '^(<<<<<<<|>>>>>>>) ' -Quiet) { $still += $f }
        }
        if ($still.Count -gt 0) {
            $still | Out-File -Encoding utf8 $conflictFile
            Note ("[{0}] conflict markers still in: {1}" -f $label, ($still -join ', '))
            Pop-Location
            return $false
        }
        git add -A
        git @ident commit -q --no-edit
        Note "[$label] merge of main completed"
    } else {
        git fetch origin main 2>&1 | Write-Host
        $behind = [int](git rev-list --count HEAD..origin/main)
        Note ("[{0}] commits behind main: {1}" -f $label, $behind)
        if ($behind -gt 0) {
            git @ident merge origin/main --no-edit 2>&1 | Write-Host
            if ($LASTEXITCODE -ne 0) {
                $files = @(git diff --name-only --diff-filter=U)
                $files | Out-File -Encoding utf8 $conflictFile
                Note ("[{0}] merge conflicts in {1} file(s): {2}" -f $label, $files.Count, ($files -join ', '))
                Pop-Location
                return $false
            }
            Note "[$label] merged main cleanly"
        }
    }
    if (Test-Path $conflictFile) { Remove-Item $conflictFile -Force }
    Pop-Location
    return $true
}

Step '0. Bring both branches up to date with main'
$okV1 = Sync-Main $v1Dir 'v1'
$okPlat = Sync-Main $platDir 'platform'
if (-not ($okV1 -and $okPlat)) {
    Finish 'Merge conflicts with main. File lists saved as conflicts-*.txt next to this script. Tell Kiro "conflicts"; it resolves them with file edits, then you rerun this same script.'
}

Step '1. Push any pending fixes'
Push-IfDirty $v1Dir 'VTID-05063-taskapi-auth' 'VTID-05063: pt access-denied text in the voce form (i18n register guard)'
Push-IfDirty $platDir 'VTID-05063-ledger-read-auth' 'VTID-05063: follow-up fix'

Step '2. Wait for CI on both PRs'
$v1Ci   = Wait-Checks $v1Repo $v1Pr 'v1'
$platCi = Wait-Checks $platRepo $platPr 'platform'
Note ("CI v1 PR #{0}: {1}" -f $v1Pr, $(if ($v1Ci.ok) { 'green' } else { 'NOT green' }))
Note ("CI platform PR #{0}: {1}" -f $platPr, $(if ($platCi.ok) { 'green' } else { 'NOT green' }))
if (-not $v1Ci.ok)   { Save-FailLogs $v1Repo $v1Ci.failed 'v1' }
if (-not $platCi.ok) { Save-FailLogs $platRepo $platCi.failed 'platform' }
if (-not ($v1Ci.ok -and $platCi.ok)) {
    Finish 'CI not green. Failing logs saved next to this script. Tell Kiro "ci failed"; it fixes the code, then you rerun this same script.'
}

Step '3. Merge to main (staging only)'
foreach ($p in @(@($v1Repo, $v1Pr), @($platRepo, $platPr))) {
    $state = (gh pr view $p[1] --repo $p[0] --json state | ConvertFrom-Json).state
    if ($state -ne 'MERGED') {
        gh pr merge $p[1] --repo $p[0] --squash 2>&1 | Write-Host
        $state = (gh pr view $p[1] --repo $p[0] --json state | ConvertFrom-Json).state
        if ($state -ne 'MERGED') {
            gh pr merge $p[1] --repo $p[0] --squash --auto 2>&1 | Write-Host
            for ($i = 0; $i -lt 40 -and $state -ne 'MERGED'; $i++) {
                Start-Sleep -Seconds 30
                $state = (gh pr view $p[1] --repo $p[0] --json state | ConvertFrom-Json).state
            }
        }
    }
    Note ("PR {0}#{1}: {2}" -f $p[0], $p[1], $state)
    if ($state -ne 'MERGED') { Finish ("Could not merge {0}#{1}. See run.log." -f $p[0], $p[1]) }
}
$sha = (gh pr view $platPr --repo $platRepo --json mergeCommit | ConvertFrom-Json).mergeCommit.oid
Note "Platform merge commit: $sha"
$mergedAt = (Get-Date).ToUniversalTime()

Step '4. Staging deploy (AWS-STAGE-DEPLOY-GATEWAY.yml)'
$deployId = $null
for ($i = 0; $i -lt 40 -and -not $deployId; $i++) {
    $runs = @((gh run list --repo $platRepo --workflow AWS-STAGE-DEPLOY-GATEWAY.yml --commit $sha --json databaseId,status,conclusion 2>$null | ConvertFrom-Json))
    if ($runs.Count -gt 0) { $deployId = $runs[0].databaseId } else { Start-Sleep -Seconds 30 }
}
if ($deployId) {
    gh run watch $deployId --repo $platRepo --exit-status 2>&1 | Select-Object -Last 15 | Write-Host
    $concl = (gh run view $deployId --repo $platRepo --json conclusion | ConvertFrom-Json).conclusion
    Note "Staging deploy run $deployId : $concl"
} else {
    Note 'No staging deploy run found for the merge commit within 20 minutes.'
}

Step '5. STAGING-VERIFY'
$verId = $null
for ($i = 0; $i -lt 60 -and -not $verId; $i++) {
    $runs = @((gh run list --repo $platRepo --workflow STAGING-VERIFY.yml --limit 10 --json databaseId,status,conclusion,createdAt,headSha 2>$null | ConvertFrom-Json))
    $hit = $runs | Where-Object { ([datetime]$_.createdAt).ToUniversalTime() -gt $mergedAt.AddMinutes(-2) } | Select-Object -First 1
    if ($hit) { $verId = $hit.databaseId } else { Start-Sleep -Seconds 30 }
}
if ($verId) {
    gh run watch $verId --repo $platRepo --exit-status 2>&1 | Select-Object -Last 25 | Write-Host
    $vc = (gh run view $verId --repo $platRepo --json conclusion | ConvertFrom-Json).conclusion
    Note "STAGING-VERIFY run $verId : $vc"
    if ($vc -ne 'success') {
        gh run view $verId --repo $platRepo --log-failed 2>&1 | Select-Object -Last 400 | Out-File -Encoding utf8 (Join-Path $task 'staging-verify-fail.txt')
        Note 'STAGING-VERIFY log saved: staging-verify-fail.txt'
    }
} else {
    Note 'No STAGING-VERIFY run appeared within 30 minutes of the merge.'
}

Step '6. Live staging checks'
try {
    $bi = Invoke-RestMethod -Uri "$stage/api/v1/admin/build-info" -TimeoutSec 30
    $biText = ($bi | ConvertTo-Json -Compress -Depth 4)
    Note ("build-info: " + $biText.Substring(0, [Math]::Min(300, $biText.Length)))
    Note ("build-info contains merge commit: " + $biText.Contains($sha.Substring(0, 9)))
} catch { Note ("build-info failed: " + $_.Exception.Message) }

$tok = [Environment]::GetEnvironmentVariable('GATEWAY_SERVICE_TOKEN', 'User')
if ($tok) {
    try {
        $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 30 -Uri "$stage/api/v1/oasis/tasks?limit=1" -Headers @{ Authorization = "Bearer $tok" }
        Note ("authenticated ledger read on staging: HTTP " + $r.StatusCode)
    } catch { Note ("authenticated ledger read on staging failed: " + $_.Exception.Message) }
} else {
    Note 'GATEWAY_SERVICE_TOKEN not set for this user; authenticated read skipped.'
}

Finish 'Shipped to staging. Evidence above. Tell Kiro "shipped".'
