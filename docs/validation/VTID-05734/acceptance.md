Change types: Infrastructure/CI.

# Acceptance — VTID-05734 (agentic-delivery-scope / lane `clone-prep`)

Outcome: the clone workflow's pre-check says why it cannot read a cluster. Before, `scripts/aws/rehearsal-clone.sh`
discarded the describe error, so an access or API error read as "source cluster vitana-aurora-prod not found" (run
43053659836, 2026-11-11 15:58 UTC). Now only `DBClusterNotFoundFault` means absent; AccessDenied reads "access denied
(the role may not describe it)" and any other error "describe failed (<error class>)", each exit 2 before any mutating
call. The mutation guard and every existing test are unchanged.

AC-1: Red on base. The two new cases fail on `origin/main`: AccessDenied and Throttling both print "not found".
TEST: `bash scripts/aws/test/rehearsal-clone.sh` with the script of `origin/main` (74 passed, 2 failed; `outputs/red.txt`)

AC-2: Green after the change: 76 passed, 0 failed, including "access denied: no mutating call" and the unchanged
"absent source -> not found" and "readable source, no clone -> absent" cases.
TEST: `bash scripts/aws/test/rehearsal-clone.sh` on this branch (exit 0; `outputs/green.txt`)

AC-3: Contract unchanged for callers: exit 0 on success, 2 on a pre-check failure, 3 on a refused target; the workflow
`.github/workflows/AWS-REHEARSAL-AURORA-CLONE.yml` is not changed.
TEST: `git diff --name-only origin/main...HEAD` lists only the two scripts and this folder

States / Surfaces / Locales / Accessibility: n/a, no UI. Staging proof: not verified on staging; the change deploys
nothing. The next `action: status` run of the workflow shows the real reason.
