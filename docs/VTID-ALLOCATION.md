# VTID allocation — the routine

Every commit gets a VTID. A session never asks anyone for a token to get one.

## Steps
1. Dispatch the VTID-ALLOCATE workflow with a title and module:
   - GitHub: Actions → VTID-ALLOCATE → Run workflow.
   - API (works from a Claude Code session): `gh api -X POST repos/exafyltd/vitana-platform/actions/workflows/VTID-ALLOCATE.yml/dispatches -f ref=main -f 'inputs[title]=<title>' -f 'inputs[module]=<module>'`
2. Wait for the run to finish. Read the `VTID_RESULT=VTID-NNNNN` line from its log.
3. Put the VTID in the PR title and in the body as `VTID: VTID-NNNNN`.
4. Add the body declarations the validator checks: VALIDATION_PROFILE, SCOPE_ALLOWLIST, ACCEPTANCE, MERGE_PAYLOAD_PREVIEW, OASIS_IMPACT.
5. Create `docs/validation/VTID-NNNNN/` with `acceptance.md` (each AC mapped to a real test), `commands.log`, `outputs/`, and `staging-tests.json` when the change deploys.

## Rules
- One VTID per PR. Do not reuse a VTID for a different change.
- Each allocation writes one real ledger row. Allocate only when a PR needs one.
- Do not invent evidence. If a check needs proof that only exists after a deploy, say so in the acceptance file.
- Do not push empty commits to re-run CI. Re-run a failed job once.

## If the workflow fails
Read the run log. Do not ask for a token. Report the failing step and stop that PR.
