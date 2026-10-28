# Sparring round 2 — in_progress

Session: `d6caa531-0937-42b4-a6c3-9085af2f4e46` · plan hash `9f26777257f69a5f2f600588dc0c917f2d17bb90849e63bfe91a398104caa9df`

## Summary

The revision addresses all three of my round-1 findings correctly (migration applier enumeration, CLAUDE.md contradiction, workflow_dispatch inventory). I verified the core premises: vitana-v1 apply-*.yml are workflow_dispatch-only with hardcoded PROJECT_REF inmkhvwdcuyhnxkgfvsb; DEPLOY.yml / supabase-functions-deploy.yml (v1) and AUTO-DEPLOY.yml (platform) have push triggers frozen by cutover_gate; RUN-MIGRATION.yml resolves target default→supabase and checks MIGRATION_FREEZE. Two defects remain. First, the plan's "Today 3" and B.6 "applier list" misclassify APPLY-FB061-DEBOUNCER-FIX.yml as a database-migration applier — it is in fact a one-shot git-patch workflow that amends source code (orb-live.ts) on a feature branch, with no SQL, no Supabase, and no production database write. Second, B.6 instructs the session to check the MIGRATION_FREEZE repo variable for the vitana-v1 apply-*.yml workflows, but those workflows never reference that variable (it is a vitana-platform Aurora-cutover construct), so the check may be a no-op and the freeze unenforced for the vitana-v1 migration path.

## Findings

### R2-F1 [major]

The plan's 'Today 3' premise and B.6 'Applier list' incorrectly classify APPLY-FB061-DEBOUNCER-FIX.yml as a database-migration applier that 'posts one hardcoded SQL file to the production Supabase ref'. The workflow actually applies an embedded git patch (PATCH_B64 → git am) to a source-code file (services/gateway/src/routes/orb-live.ts) plus a test file, on the feature branch 'claude/gallant-feynman-Wn13y', then bypasses the branch. It contains no SQL, touches no Supabase/database, and does not write to production — it writes source code to a non-main branch. Treating it as a migration under B.6 (owner approval naming SQL path + sha256 + target:supabase + MIGRATION_FREEZE) is nonsensical for a code-patch workflow, and the premise statement is factually false.

- `exafyltd/vitana-platform:.github/workflows/APPLY-FB061-DEBOUNCER-FIX.yml:53` — run: |
    echo "$PATCH_B64" | base64 -d > /tmp/fb061.patch
    git am -3 --keep-cr /tmp/fb061.patch
...
    git rm .github/workflows/APPLY-FB061-DEBOUNCER-FIX.yml
...
    run: git push origin HEAD:claude/gallant-feynman-Wn13y
- `exafyltd/vitana-platform:.github/workflows/APPLY-FB061-DEBOUNCER-FIX.yml:54` — PATCH_B64: 'RnJvbSBjYmMwMDllNTEzODI5MWYyY2ZhNGNjYTU1ZmQzNjA3ZDEzNTgzMTdjIE1vbiBTZXAgMTcgMDA6MDA6MDAgMjAwMQpGcm9tOiBDbGF1ZGUgPG5vcmVwbHlAYW50aHJvcGljLmNvbT4...U2VydmljZXNfaGFuZGxlcnMifQ=='

Suggestion: Remove APPLY-FB061-DEBOUNCER-FIX.yml from the B.6 migration 'applier list' and correct 'Today 3'. It is a one-shot virtual (code patch) workflow, not a database migration. Either explicitly exclude it from migration governance with a note that it is a self-deleting code patch touching a feature branch (and so outside B.6's production-database scope), or add a separate governance note about one-shot code-patch workflows.

### R2-F2 [minor]

B.6 instructs the session to check the MIGRATION_FREEZE repo variable before dispatching the 21 vitana-v1 apply-*.yml workflows ('Those workflows have no freeze guard, so the session checks MIGRATION_FREEZE (repo variable) itself and does not dispatch while it is true'). But the vitana-v1 apply-*.yml workflows never reference MIGRATION_FREEZE, and MIGRATION_FREEZE is a vitana-platform construct introduced for the Aurora cutover (RUN-MIGRATION.yml, VTID-05023). There is no evidence vitana-v1 defines this repo variable; if it does not, the session's check is a no-op and the schema freeze is not actually enforced on the vitana-v1 production-database path, leaving those migrations ungoverned during a freeze window.

- `exafyltd/vitana-v1:.github/workflows/apply-july-19-kira-ticket-price-migration.yml:17` — jobs:
  apply:
    runs-on: ubuntu-latest
    env:
      PROJECT_REF: inmkhvwdcuyhnxkgfvsb
    steps:
      - uses: actions/checkout@v4
      - name: Apply migration via Supabase Management API
...
        migration = 'supabase/migrations/20260703000000_fix_july_19_kira_ticket_price.sql'
- `exafyltd/vitana-platform:.github/workflows/RUN-MIGRATION.yml:33` — While the repo variable MIGRATION_FREEZE is 'true' ... nothing is applied to either database.

Suggestion: Verify whether vitana-v1 defines a MIGRATION_FREEZE repo variable. If it does, cite it; if not, the plan must either (a) add MIGRATION_FREEZE enforcement to the vitana-v1 apply-*.yml workflows (out of this plan's rule-only scope), or (b) explicitly constrain the MIGRATION_FREEZE check to vitana-platform RUN-MIGRATION.yml and document that the vitana-v1 per-file appliers have no freeze mechanism — and gate their dispatch on the owner's explicit approval at the time of dispatch, which is already required by B.6.

## Acknowledgements of earlier responses

- R1-F1: acknowledged — B.6 now enumerates all appliers (RUN-MIGRATION.yml, APPLY-FB061, 21 vitana-v1 apply-*.yml) with per-target owner approval, hash, and freeze checks. Verified the vitana-v1 apply-*.yml structure.
- R1-F2: acknowledged — CLAUDE.md roles sentence is replaced with §7d wording and §7's merge sentences are rewritten; a grep test asserts the old sentence is absent.
- R1-F3: acknowledged — Tests add a workflow inventory checking every apply-*.yml / APPLY-*.yml is workflow_dispatch-only.

## Next

Planner: answer every finding above in `sparring/s2-responses-2.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
