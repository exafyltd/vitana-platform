# Acceptance — VTID-05469 (mt-guardrails-r2 / local-test-stack-v2)
| Acceptance | Evidence |
|---|---|
| T0 spike: pinned image boots, pgtap availability recorded, replay run, required tables checked | MT-LOCAL-STACK job log on this PR (smoke-summary block); copied to `spike.md` after the run |
| T1 skip-list of migrations failing on a fresh DB | `supabase/tests/local-stack/replay-skip.json`, filled from the job's `replay-report.json` |
| T2 fixtures T_A/T_B, five members, CANARY_A markers, idempotent, INSERT into pre-existing auth.users | `supabase/tests/fixtures/00_tenants_members.sql`; smoke step "seed" runs it twice |
| T3/T4 up.sh / pins (image tag + digest, apt pin, ubuntu-24.04) | `scripts/mt/stack/up.sh`, `smoke.sh`, `docs/multitenancy/LOCAL-STACK.md` |
| T5 smoke: auth.users pre-exists, fixtures load, pgtap/pg_prove available | `supabase/tests/local-stack/00_smoke.sql` via pg_prove in the job |
| T6 CI job: pull_request, ubuntu-24.04, contents: read, no secrets | `.github/workflows/MT-LOCAL-STACK.yml` |
| No live system | no remote host in any script (grep in commands.log) |
