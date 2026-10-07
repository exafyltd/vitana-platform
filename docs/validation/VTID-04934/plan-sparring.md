# Plan sparring record — keep the ORB WebSocket transport off on production

- Partner: `plan-sparring-partner` agent (read-only; Claude Code subagent definition `.claude/agents/plan-sparring-partner.md`, model `claude-opus-4-6`)
- Change class: expedited (P1) · rounds: 2 · verdict: **CONVERGED**
- Final plan hash (sha256 of the text between the plan markers): `01d9dcf0aedca266c8291548f66a759b2afacff669f426df17abc23d9595da55`
- Owner approval: 2026-10-07, in the Claude Code session (AskUserQuestion: "Approve both")
- Note: a first attempt ran a substitute read-only reviewer before the partner type was loaded; it was stopped before returning and its output is not used (rule 53).

## Final plan
# Plan: keep the ORB WebSocket transport OFF on production (durable rollback of VTID-04866)

<!-- plan:begin -->
**Change class:** expedited (P1 incident: member Orb voice sessions not working on production). Touches a `.github` deploy workflow.

**Scope:** `.github/workflows/AWS-PROD-DEPLOY-GATEWAY.yml`, `services/gateway/src/services/conversation/conversation-flag-pins.generated.ts` (regenerated), `services/gateway/test/orb/live/upstream/staging-ws-transport-flag-pinned.test.ts`, `docs/validation/<VTID>/` evidence pack.

**Evidence (production, read-only):**
- `oasis_events` topic `vtid.live.session.stop`: on 2026-10-03 (SSE transport) 15 member sessions, avg 33 s, 11 with user turns. From 2026-10-04 16:09 UTC (prod pinned to WS by VTID-04866, PR #3898) to 2026-10-07: ~190 WebSocket sessions, avg ~2 s, 0 with user turns, most with 0 audio out (reason mostly `ws_stop_session`).
- Example member session `live-9ba11989` (iPhone app WebView, 2026-10-07 05:59): tap → WS start → widget `_hide()` 1.3 s later (`orb.session.continuity.persisted reason=hide`) before `session_started` arrived (client latency beacon has no `session_started` mark) → `_sessionStartWs` bail sends `{type:'stop'}` (orb-widget.js ~L2896) → server `ws_stop_session`.
- Rollback already dispatched 2026-10-07 07:35 UTC: `AWS-PROD-DEPLOY-GATEWAY.yml` env-only run #374 with `env_overrides={"FEATURE_ORB_WS_TRANSPORT_ENV":"off"}`. That override lasts one dispatch; the unconditional pin at ~L644 (`{name:"FEATURE_ORB_WS_TRANSPORT_ENV", value:"staging+prod"}`) re-enables WS on the next PUBLISH.

**Change:**
1. In the prod workflow's always-pinned flag block, change the pinned value from `"staging+prod"` to `"off"`, keep it in the strip list (so a stale value cannot survive), and rewrite the 5-line comment: WS disabled on prod after the 2026-10-04..07 regression; re-enabling is a new VTID with a device-verified fix.
2. Regenerate `conversation-flag-pins.generated.ts` with `scripts/conversation/generate-flag-pins.mjs` (prod becomes `"off"`).
3. Update `services/gateway/test/orb/live/upstream/staging-ws-transport-flag-pinned.test.ts` (current L57-82):
   - describe `'VTID-04866: prod pins FEATURE_ORB_WS_TRANSPORT_ENV'` becomes `'VTID-04866 rollback: prod pins FEATURE_ORB_WS_TRANSPORT_ENV to "off"'`, with a header comment citing this VTID and the 2026-10-04..07 regression.
   - it `'upserts the flag as "staging+prod" (the value that is live on prod)'` becomes `'upserts the flag as "off" so WebSocket stays off on prod'`; the positive regex asserts `{name:"FEATURE_ORB_WS_TRANSPORT_ENV", value:"off"}`; the negative assertions check that neither `value:"staging+prod"` nor `value:"staging-only"` is pinned on prod.
   - the strip-list test and the "pinned before env_overrides" test keep their logic but locate the pin by the new string `{name:"FEATURE_ORB_WS_TRANSPORT_ENV", value:"off"}`.
   - The staging block (`staging-only`) is unchanged, so the WS failure can be reproduced on staging (read-only by construction, CLAUDE.md rule 48).
4. Evidence pack (`acceptance.md` with TEST: mapping, `commands.log`, `outputs/`, `staging-tests.json`: `/alive` 200 + the CI tests; post-PUBLISH prod check is a read-only `GET /api/v1/orb/live/transport` → `"sse"`).
5. `FEATURE_ORB_NOVA_PREWARM_ENV` and `FEATURE_ORB_GREETING_PREBUFFER_ENV` act only on the WS path, are not pinned on prod, and stay inert with WS off; no change.
6. Out of scope (separate follow-up VTID): root cause of why the widget hides during the WS handshake on mobile WebViews, and the original deploy-overlap SSE split (VTID-04866's motivation), which returns with SSE.

**Governance:** expedited class, normal sparring (this record); not break-glass, the gateway is up.

**Risk:** no application-logic change ships; the only production-behavioural change is the env pin in the deploy workflow (the generated pins file and the test mirror it). Returns prod to the SSE path that handled member conversations on 2026-10-03, including its known deploy-overlap split (~45 s per prod deploy). 
<!-- plan:end -->

## Planner responses (round 1)
- F1 ACCEPTED — risk section reworded: no application-logic change ships; only the env pin changes production behaviour; the generated file and the test mirror it.
- F2 ACCEPTED — new item 5: NOVA_PREWARM / GREETING_PREBUFFER are WS-only, unpinned on prod, inert with WS off; no change.
- F3 ACCEPTED — item 3 now spells out the describe/it renames, the positive assertion (`value:"off"`), the negative assertions (`staging+prod` and `staging-only` not pinned on prod), and how the two remaining tests locate the pin.
- F4 ACCEPTED — item 3 notes staging reproduction is read-only by construction (rule 48).
- F5 ACCEPTED — Governance line added: expedited, normal sparring, not break-glass.
- Q1 — `generate-flag-pins.mjs` reads only the two workflow files (`scripts/conversation/generate-flag-pins.mjs:22-23,43`); `vtid-04525-conversation-flag-registry.test.ts:102` runs it with `--check`. No live task definition is read, so regenerating before the test is sufficient.
- Q2 — confirmed: the workflow change is proven by the Jest tests in CI (and re-run by STAGING-VERIFY as an "existing" ref). The behavioural proof is the post-PUBLISH read-only prod check `GET /api/v1/orb/live/transport` → `"sse"` (already true today via the env-only rollback).

## Round 1 — partner findings (verbatim)
Verified premises: L644 pin = "staging+prod" TRUE (`AWS-PROD-DEPLOY-GATEWAY.yml:644`); pins file regenerated by `scripts/conversation/generate-flag-pins.mjs` TRUE (`conversation-flag-pins.generated.ts:47`); test asserts "staging+prod" TRUE (`staging-ws-transport-flag-pinned.test.ts:63-64`); env_overrides one-dispatch TRUE (workflow L634, L637-644).
- F1 [minor] "No code change ships" contradicts items 2 and 3 (generated file and test change). Suggestion: reword risk.
- F2 [minor] NOVA_PREWARM / GREETING_PREBUFFER (WS-only, unpinned on prod, L635-636) not mentioned.
- F3 [major] Test update incompletely specified: describe/it text and the negative assertion must change, not only the regex (`staging-ws-transport-flag-pinned.test.ts:57-82`).
- F4 [minor] Note staging reproduction is read-only / uses production Supabase.
- F5 [minor] State whether this is break-glass or normal sparring.
- Q1: does the registry test validate against the live task definition? Q2: confirm the workflow change is proven by CI.
- Verdict: NOT CONVERGED (F3).

## Round 1 — planner responses
(See "Planner responses (round 1)" in the final plan above: F1–F5 ACCEPTED, plan changed; Q1 answered — generator reads only the two workflow files, `generate-flag-pins.mjs:22-23,43`; Q2 answered — CI Jest + post-PUBLISH read-only `/orb/live/transport` check.)

## Round 2 — partner (verbatim summary)
F1 closed · F2 closed · F3 closed ("Item 3 now spells out the describe rename, it-block rename, positive assertion (`value:"off"`), both negative assertions … and confirms the strip-list and ordering tests locate by the new string") · F4 closed · F5 closed · Q1 satisfied (verified `generate-flag-pins.mjs:22-23,43`) · Q2 satisfied. No new blocker or major findings. **Verdict: CONVERGED.**
