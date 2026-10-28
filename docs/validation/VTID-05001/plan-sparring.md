# Plan sparring record — VTID-05001

- Partner: `plan-sparring-partner` agent (read-only; `.claude/agents/plan-sparring-partner.md`, model `claude-opus-4-6`)
- Change class: standard · rounds: 2 · verdict: **CONVERGED**
- Final plan hash (sha256 of the text between the plan markers): `10910d50dcac88428dd33df7fbbfb96dcab0e13e58719b9a0d686e462576cf6c`
- Owner approval: 2026-10-08, in the Claude Code session ("Approve both", Gate 1, VTID-04947)

## Final plan
<!-- plan:begin -->
**Change class:** standard (Orb widget JS served by the gateway + one gateway route + tests; no migration, no deploy-workflow change).

**Scope:** `services/gateway/src/frontend/command-hub/orb-widget.js`, `services/gateway/src/frontend/command-hub/index.html` (`?v=` cache-bust, IF-THEN 25), `services/gateway/src/routes/orb-live.ts` (continuity route only, ~L16285-16330), new/updated Jest tests under `services/gateway/test/orb/`, `docs/validation/<VTID>/`.

**Evidence (read-only):**
- Prod 2026-10-04..07 on WebSocket: ~190 sessions, 0 user turns. Traced session `live-9ba11989` (iPhone app WebView): the widget's `_hide()` ran 1.3 s after the tap, before `session_started`; `_sessionStartWs`'s `bail()` (orb-widget.js ~L2897-2911, triggered by `!_s.overlayVisible` at ~L2917) sent `stop` → server `ws_stop_session`.
- `_hide()` has 40 call sites (41 occurrences incl. the definition at ~L5466). The continuity POST (`_persistContinuity('hide', 15)`, ~L5558) and its OASIS event `orb.session.continuity.persisted` (orb-live.ts ~L16317) record only `reason:"hide"` — nothing says WHICH caller closed the overlay. The root cause cannot be read from today's data.
- Prod has served `transport:"sse"` since 2026-10-07 09:47, yet `vtid.live.session.stop` shows real members on `transport:"websocket"` after that (user `bc34…` 2026-10-07 10:43, 13:50, 15:05 and 2026-10-08 13:17, all `ws_stop_session`, 0 turns). Cause in code: `_useWsTransport()` (~L1407-1418) falls back to the compiled default `transport: 'ws'` (~L227) whenever `GET /live/transport` (`_fetchServerTransport`, ~L1422) has not answered yet or failed. So the kill switch does not reliably keep a client off WebSocket.
- Candidate callers (hypotheses, not established): `setViewRole` restart (~L6349-6361, called by vitana-v1 `useOrbVoiceWidget.ts` ~L157-163 on every `currentRole` change: hide + re-show 300 ms later), FAB/host double activation (`_renderFab` click toggle ~L4930, `toggle()` ~L6339), guided-topic auto-close. Background watchdog is excluded (needs >30 s timer drift, ~L4786-4794).

**Change:**
1. **Kill switch honoured (ships first, behaviour fix):** compiled default `transport` becomes `'sse'`; `_useWsTransport()` returns true only for the localStorage developer override `'ws'` or an explicit server answer `'ws'`. Server `'ws'` (staging-only) keeps staging on WebSocket. Unit test pins: no server answer → SSE; server `'sse'` → SSE; server `'ws'` → WS; override wins.
2. **Hide-reason telemetry:** `_hide(reason)` takes a short reason code and defaults internally (`reason = typeof reason === 'string' && reason ? reason : 'unknown'`), so a missed or `setTimeout(_hide)` caller reports `unknown`; every one of the 40 call sites passes one (e.g. `fab_toggle`, `api_toggle`, `view_role_change`, `close_button`, `bg_watchdog`, `session_ended`, `guided_auto_close`, `nav_close`, …; an uncoded caller sends `unknown`). `_persistContinuity` sends `hide_reason`, ms since the last tap, the transport, and the start phase (`connecting` / `started`). The continuity route copies these four fields into the OASIS event payload after allowlisting `hide_reason` against a fixed list and clamping the numbers; anything else is dropped. No new table, no new write path (the route already writes this row and event). Tests: (a) a Jest test parses `orb-widget.js` with `espree` (already in node_modules) and asserts every `CallExpression` to `_hide` passes a string literal from the allowlist (comments and strings are not matched; a non-literal argument fails the test with its line); (b) route tests for the allowlist, clamping, and a body without the new fields. **Compatibility:** widget and route ship in the same gateway image; an older cached widget sends none of the fields and the route behaves exactly as today (fields omitted from the payload). The existing OASIS event payload gains four optional fields; no new table, route or row.
3. **Data collection (read-only):** the reason is transport-agnostic — the SSE start path bails on the same `!_s.overlayVisible` check (~L2706, ~L2718), so prod (SSE) data is valid evidence. After PUBLISH, via read-only SQL on `oasis_events` (this session has it), query `orb.session.continuity.persisted` on prod for 3-5 days: distribution of `hide_reason` where ms-since-tap < 5000 and phase `connecting`. Staging (WebSocket on) gets the same data from the owner's own device sessions in mobile Safari. No automated test opens a voice session.
4. **The actual fix is a separate, sparred plan** once step 3 names the caller. This plan does not re-enable WebSocket on prod.

**Out of scope:** the SSE deploy-overlap split (Plan D); any change to vitana-v1.

**Staging tests (read-only):** `GET /command-hub/orb-widget.js` on staging contains `transport: 'sse'` and the `hide_reason` field; the route's new fields are proven by the Jest route tests (a staging POST would be a write); `GET /api/v1/orb/live/transport` on staging returns `"ws"`; existing smoke suite.

**Risk:** step 1 changes which transport a client picks only when the server has not answered — that case now goes to SSE (the path prod uses today). Step 2 adds fields to an existing request/event; the route ignores unknown values.
<!-- plan:end -->

## Round 1 — partner findings
**Verified premises (partner):** compiled default `transport: 'ws'` at `orb-widget.js:228` — TRUE; `_useWsTransport()` falls back to the compiled default (`orb-widget.js:1407-1416`) — TRUE; "41 call sites" — PARTIAL (41 occurrences incl. the definition at `orb-widget.js:5466`); continuity POST and event record only `reason:'hide'` (`orb-widget.js:5558`, `orb-live.ts:16313-16321`) — TRUE; `setViewRole` hide + re-show 300 ms (`orb-widget.js:6358-6361`, `useOrbVoiceWidget.ts:157-163`) — TRUE; background watchdog needs >30 s drift (`orb-widget.js:4786-4787`) — TRUE.

- **F1 [minor]** Call-site count is 40, not 41 (`orb-widget.js:5466` is the definition).
- **F2 [minor]** Plan scope omits the required `index.html` cache-bust (CLAUDE.md IF-THEN 25; `index.html:16`).
- **F3 [major]** New continuity fields: deploy-ordering and backward compatibility for existing clients not addressed (route reads only `reason`, `ttl_minutes`, `value`, `clear` at `orb-live.ts:16295`).
- **F4 [major]** A regex static scan for `_hide(` in a 6000+ line JS file is fragile (comments, strings, variables, multi-line); parse the AST (`acorn`/`espree`) or document the brittleness.
- **F5 [minor]** "No new write path" is slightly misleading — the event payload shape changes; say "no new table, route or row; payload gains four optional fields".
- **F6 [minor]** `_hide` takes no parameter today; state that it defaults `undefined` to `'unknown'`.
- **F7 [minor]** Staging tests cover step 1 but not step 2's route fields; add a check or accept the Jest route test explicitly.
- **Q1** Does the SSE start path have the same overlay bail as WS (`orb-widget.js:2917`)?
- **Q2** Can the planner query OASIS events directly for step 3?

Partner verdict round 1: NOT CONVERGED (F3, F4).

## Planner responses (round 1)
- F1 ACCEPTED — 40 call sites (41 occurrences incl. the definition).
- F2 ACCEPTED — `index.html` `?v=` bump added to scope.
- F3 ACCEPTED — compatibility stated: widget and route ship in one gateway image; an older cached widget sends no new fields and the route behaves as today; payload gains four optional fields.
- F4 ACCEPTED — AST scan with `espree` (present in `services/gateway/node_modules`): every `_hide` CallExpression must pass an allowlisted string literal; non-literal fails with its line.
- F5 ACCEPTED — wording changed: no new table, route or row; the existing event payload gains four optional fields.
- F6 ACCEPTED — `_hide` defaults a missing/non-string reason to `unknown`.
- F7 ACCEPTED (variant) — route fields proven by Jest route tests (a staging POST would be a write, rule 48); staging data from the owner's own sessions is observation, not a gate.
- Q1 — the SSE start path has the same bail (`orb-widget.js` ~L2706, ~L2718: `_userInitiatedStop || !overlayVisible`), so the hide reason is transport-agnostic and prod SSE data is valid evidence. Step 1 removes WS only where the server did not ask for it; it does not change the hide race.
- Q2 — yes, read-only SQL on `oasis_events` from the session (used for this plan's own evidence).


## Round 2 — partner response
**Verified premises (partner):** 40 call sites + definition — TRUE; SSE bail at `orb-widget.js:2706` and `:2718` — TRUE; `espree` present in `services/gateway/node_modules` — TRUE; `index.html` cache-bust in scope — TRUE.

F1–F7 closed; Q1 closed (SSE bail matches the WS bail at `:2917`, telemetry is transport-agnostic); Q2 closed. No new blocker or major findings.

Partner verdict round 2: **CONVERGED**.
