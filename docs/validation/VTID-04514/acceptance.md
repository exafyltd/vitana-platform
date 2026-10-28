# VTID-04514 — Community Autopilot CA-9: drop never-written Autopilot tables

Step CA-9 of `docs/COMMUNITY-AUTOPILOT-V2-PLAN.md`. The code change lives in
`exafyltd/vitana-v1` (where the tables were created); this repo records it in
`DATABASE_SCHEMA.md`.

## Facts (live, 2026-09-24, read-only)
- 0 rows in `autopilot_actions`, `autopilot_action_templates`, `automation_executions`, `autopilot_feedback`.
- No view or function body references them; the only FK into them is `autopilot_feedback → autopilot_actions`.
- Readers found: `fetch-user-context`, `get-proactive-context`, `analyze-patterns`, `request-account-deletion` (edge functions). The CA-0 note "no code references" was wrong: it only searched the gateway and the app.

## Acceptance criteria

AC-1: No app or edge-function source queries the four tables.
TEST: vitana-v1 src/lib/dead-autopilot-tables.test.ts

AC-2: The drop migration refuses a table that has rows, and drops `autopilot_feedback` before `autopilot_actions`.
TEST: vitana-v1 src/lib/dead-autopilot-tables.test.ts

AC-3: The guard block passes against the live project (run inside `BEGIN READ ONLY … ROLLBACK`).
TEST: docs/validation/VTID-04514/outputs/verification.txt (guard run inside a READ ONLY transaction, rolled back)

## Not done here, owner steps
1. Deploy the four edge functions (manual dispatch of `supabase-functions-deploy.yml`).
2. Then apply the migration. It is deliberately not wired to any apply workflow, and it was not applied from this session: dropping a table that deployed code still queries would turn an empty read into an error.
