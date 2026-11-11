# VTID-05698 — acceptance (lane `write-route-inventory`, plan `gateway-write-route-auth`)

Pin: `6dc6e1ba0c18252ec2f3fbf5651d245e200f9835`. Report: `docs/programs/security/gateway-write-route-inventory.md`.
Change type: Tooling/docs. No code, no behaviour, no test (red-green exempt, `scope.json`).

## Acceptance (tasks.md, lane `write-route-inventory`)

AC-1 Every write route of the pin has exactly one verdict with a `file:line`; counts per verdict match the table.
- Evidence: report §1 (counts) and §10 (837 rows; definition column is `file:line`, mount column cites `index.ts:<line>`).
TEST: table recount in `commands.log` ("Table recount"): 837 rows; gated 469, gated in handler 214, public by design 44, unauthenticated and needs a gate 104, in progress (VTID-05697) 6, Unknown 0; 0 rows without a `file:line`. Same numbers as §1.
TEST: `node docs/validation/VTID-05698/check-citations.mjs` → 2366 distinct citations in 512 files, 0 failed (`commands.log`, "Citation check"); negative test fails as expected.
- Scope note: the one route defined but never mounted (`routes/live.ts:2593`) is reported in §2 and excluded from the counts.

AC-2 The heuristic command and its output count (123 at the pin) are in `commands.log`; each heuristic hit is resolved.
- Evidence: `commands.log` "Heuristic (reproducible)": the script text, the variants tried with their counts, and the reference run `hits=123 files=48`.
- Deviation, stated: the plan's original command is not stored on the plan branch, so its file count (45) could not be reproduced; the reference variant reproduces the hit count (123) with 48 files.
TEST: the `list` output of the reference run is resolved line by line against the table in `commands.log`: 120 hits are route definitions (gated 9, gated in handler 43, public by design 17, needs a gate 49, in progress 2); 3 hits are `Map.delete()` calls, not routes. Because all 837 rows carry a verdict, every hit of every variant is resolved.

AC-3 Every "needs a gate" row names an existing gate and its callers; no fix is presented as done.
- Evidence: report §4 (104 rows: severity, existing gate, callers found) and §8 (FU-1..FU-16: routes, files, severity, gate, callers, owner, approval gate; "None is done by this lane").
TEST: table recount in `commands.log`: 0 needs-gate rows without a named gate.
- Gates named are existing ones only: `requireServiceOrAdmin`, `requireAdminOnly`, `requireAdminAuth`, `requireAuth`, `requireAuthWithTenant`, `requireLedgerWriteAuth` / `requireScheduledNotificationsAuth` (switch to `enforce`), Stripe `constructEvent` (pattern of `routes/stripe-connect-webhook.ts:111`), and an HMAC stream token modeled on `services/gateway/src/services/kiro/kiro-mcp-token.ts:47-70`.

AC-4 Only the lane `paths` change; no code.
TEST: `git diff --name-only origin/main...HEAD` lists only the lane file, `docs/programs/security/gateway-write-route-inventory.md` and `docs/validation/VTID-05698/**` (Lane scope check in preflight and CI).
- Evidence: `commands.log` "Repository state": `git status --short` shows only `docs/programs/security/` and `docs/validation/VTID-05698/` (untracked). No git write was run.

## Tasks

- T1 (list every POST/PUT/PATCH/DELETE route with mount path): report §2 items 1-3, §10. `all` routes are included.
- T2 (gate, identity, effect, callers, verdict; severity and gate for "needs a gate"): report §10 columns; §4.
- T3 (worker-orchestrator × VTID-05686 register): report §7 (AR-07, AR-12; register read from branch `kiro/strategy-execution-wave1/autonomy-risks`, `commands.log`).
- T4 (GET routes serving data of the six routes, triage stream first; openclaw-bridge writes): report §5 (EventSource-compatible stream-token design, severity medium) and §6 (credential decision is the owner's).

## Not verified (status Unknown, report §9)

Live exposure and upstream AWS rules; production values of `LEDGER_WRITE_AUTH_MODE`, `SCHEDULED_NOTIFICATIONS_AUTH_MODE`, `ENVIRONMENT`/`VITANA_ENV`, `SERVICE_AUTH_TOKEN`, `autopilot_execution_enabled`; production callers of routes with no code caller; the worker-runner source. No claim in the report is "Verified operational".
