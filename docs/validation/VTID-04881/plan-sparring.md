# Plan sparring record — VTID-04881

- Sparring session: `8e7d8aec-41a8-4d93-88c5-c90128bd9adb` (plan_sparring_sessions, attested)
- Plan hash (sha256 of the text between the plan markers): `6016f48450f16078e015c0b42f22c3f223b6c118655758581813e7c6dbdc1b02`
- Partner: independent read-only subagent following .claude/agents/plan-sparring-partner.md
- Rounds: 3. R1 NOT CONVERGED (4 major, 4 minor); R2 NOT CONVERGED (F9 blocker: a client-supplied session_id would cross users; F10 major); R3 CONVERGED
- Owner approval: in-session, 2026-10-05 ("Approve", code and tests only; the orb-agent is not deployed)

---

# Plan B — LiveKit orb-agent navigation wrappers pass intent and entity ids

<!-- plan:begin -->
## Context
The gateway's shared tools (`services/gateway/src/services/orb-tools-shared.ts`)
are the navigation backend for every voice pipeline. Nova Sonic and the cascade
call them with the full schema in `live-tool-catalog.ts`, and orb-live.ts
injects `is_mobile`, `transcript_excerpt`, `lang` and `session_id` server-side.

- `navigate` takes `question` and a required `intent` (open|where).
  The gateway turns a missing intent into "where" (orb-tools-shared.ts:3553),
  and "where" only offers, it never opens.
- `navigate_to_screen` takes `screen_id` (legacy `target`), `reason` and
  the entity ids. Since VTID-04846 those ids fill the entity routes. With no
  id the result is `missing_param`.

The LiveKit orb-agent (`services/agents/orb-agent/src/orb_agent/tools.py`) is
the standby voice worker; its prod deploy is manual-dispatch only. Today:
1. `navigate` forwards only question, current_route and recent_routes. So
   "open my wallet" never opens, and there is no `is_mobile`.
2. `navigate_to_screen` forwards `target` and the gates, but no entity ids.
   Every entity screen fails.
3. Neither wrapper forwards the member's own words (`transcript_excerpt`),
   which the gateway uses for resolution (VTID-04629).
4. `/orb/tool` (routes/orb-tool.ts:59-64) builds the identity without `lang`,
   so on LiveKit every shared tool answers in English.
5. The two wrappers keep the route ring buffer differently.

## Change class
standard: orb-agent (tools.py, session.py, a new test) plus one gateway route.

## Scope / files
- `orb-agent/src/orb_agent/tools.py`
  - `navigate(context, question, intent)`: `intent` is REQUIRED (no default),
    matching the schema. It is normalised to open|where; anything else becomes
    "where", like the gateway. The call forwards `is_mobile`, `is_anonymous`
    and `transcript_excerpt` (below). The docstring explains open vs where as
    NAVIGATE_V2_DECLARATION does.
  - `navigate_to_screen(context, screen_id="", target="", reason="",
    keep_orb_open=False, **entity ids)`. The parameters use the gateway's own
    names, so no translation table can drift: recipient_id, chat_group_id,
    groupId, roomId, match_id, intent_id, vitana_id, id, event_id, meetup_id,
    user_id. Every one of them is optional and only forwarded when non-empty.
    A module constant `NAVIGATE_TO_SCREEN_ENTITY_ARGS` lists them.
  - One shared `_track_route(gw, res)` helper for both wrappers: use
    `base_route` (else the route without its query), skip `already_there`,
    skip `entry_kind == 'overlay'`, and keep the 5-entry ring buffer.
  - `_dispatch` / `_dispatch_with_directive` send top-level `lang`
    (`gw.identity_lang`) next to `name`/`args`, for every LiveKit tool.
    This is deliberate: every shared tool on LiveKit answers in the member's
    language. **No `session_id` is sent.** The server keys per-session state
    on it, so a client-supplied value would cross users (F9).
- `orb-agent/src/orb_agent/session.py`: the existing
  `user_input_transcribed` hook already holds the user text. On a FINAL
  transcript it also sets `gw.last_user_text`. Both nav wrappers send it as
  `transcript_excerpt`, capped at 500 chars. It is never an LLM parameter.
- `gateway_client.py`: declare `last_user_text` and `identity_lang` in
  `__init__` (session.py already sets `identity_lang`).
- `services/gateway/src/routes/orb-tool.ts`: the identity takes `lang` from
  the body only when it is a short locale string
  (`/^[a-z]{2}(-[A-Za-z]{2,4})?$/`). It is lower-cased, and only the base
  language code is kept. `lang` only chooses the output language; auth, role,
  tenant and session stay server-derived. A body `session_id` is ignored.
  Plus a jest test: valid, invalid and missing lang, and a body `session_id`
  that never reaches the identity.
- `orb-agent/tests/test_nav_tool_args.py` with a fake dispatcher. It checks:
  - the exact args for open, where, missing intent and invalid intent;
  - `is_mobile` forwarded;
  - every entity param forwarded under its gateway name;
  - legacy target-only still works;
  - `transcript_excerpt` comes from `gw.last_user_text`;
  - `_track_route` handles overlay, already_there and base_route;
  - `inspect.signature`: every navigate_to_screen extra has a default, and
    `intent` has none;
  - `NAVIGATE_TO_SCREEN_ENTITY_ARGS` equals the param set the registry needs
    (read from vitana-v1 screens.json, skipped when that file is absent) plus
    the catalog's aliases;
  - the livekit schema assertion is behind `pytest.importorskip("livekit.agents")`.
- `voice-pipeline-spec/spec.json`: `navigate_to_screen` implementations
  become ["vertex","livekit"], and the stale "LiveKit exposes only navigate"
  note is replaced.

## Not in scope
- Deploying orb-agent to production. It is a standby worker, its deploy is a
  separate manual decision, and the owner is told.
- The gateway change is backward compatible. Without `lang`, behaviour is
  unchanged. It ships with the normal gateway staging flow.

## Verification
- `pytest services/agents/orb-agent/tests` runs locally. No CI job runs
  orb-agent pytest, and the PR says so.
- Gateway: jest for the orb-tool route test and the navigation tests,
  `npm run test:support` (rule 42c: report_to_specialist reads `id.lang`),
  the full gateway suite, typecheck and lint. The PR states the behaviour
  change: LiveKit tool replies follow the member's language.
- Staging: the gateway change rides STAGING-VERIFY's gateway smoke. The
  route test is the proof, since staging specs are read-only and `/orb/tool`
  is a POST.
<!-- plan:end -->


## Planner responses (round 1)
- F1 ACCEPTED: navigate forwards is_mobile and is_anonymous. Tested.
- F2 ACCEPTED: intent is required with no default; unknown values become "where". Tested.
- F3 ACCEPTED: event_id, meetup_id and user_id added. One constant, checked against the registry params in a test.
- F4 ACCEPTED (inject): session.py stores the final user transcript on gw, and both wrappers forward it as transcript_excerpt. It is not an LLM param.
- F5 ACCEPTED: a shared `_track_route` helper (base_route, skip already_there, skip overlay).
- F6 ACCEPTED: inspect.signature tests, the schema check behind importorskip, and the PR states the suite is local-only.
- F7 ACCEPTED: spec.json implementations and note updated.
- F8 ACCEPTED (in scope): the agent sends lang and session_id top-level, and orb-tool.ts takes them into the identity with validation.
- Q2: keep_orb_open is exposed (optional, default False).
- Q3: the gateway's own names are used directly; no mapping table.

## Planner responses (round 2)
- F9 ACCEPTED, option (c): session_id is dropped entirely; only `lang` is sent. The route ignores a body session_id, and a jest case proves it. Navigation loses nothing that matters (session id is only OASIS grouping there).
- F10 ACCEPTED, global lang kept on purpose. Verification now names `npm run test:support` and the full gateway suite, and the PR states the behaviour change.
- Q1: moot under (c).

## Verdict
CONVERGED (round 3). F9 is closed, F10 acknowledged. The PR notes that LiveKit navigator OASIS events stay ungrouped by session.

---

## Partner findings (as raised)

### Round 1 — NOT CONVERGED
- F1 [major] Turning on intent=open for LiveKit `navigate` would open the desktop route for mobile members — the wrapper never sends `is_mobile`.
- F2 [major] Defaulting `intent="open"` reverses the gateway's and Vertex's safe "where" default (the schema marks intent required).
- F3 [major] The new signature omitted event_id, meetup_id and user_id — those overlay screens would still fail with missing_param.
- F4 [major] `transcript_excerpt` is injected server-side for Vertex/Nova, not an LLM parameter; either inject it from the agent or name the gap.
- F5 [minor] The two wrappers kept the route ring buffer differently (route with query, already_there).
- F6 [minor] The generated function_tool schema cannot be asserted without livekit installed; no CI runs orb-agent pytest.
- F7 [minor] spec.json still said "LiveKit exposes only navigate".
- F8 [minor] `/orb/tool` sets no `lang`, so LiveKit navigation text is always English.

### Round 2 — NOT CONVERGED
F1–F8 closed. New:
- F9 [blocker] Taking `session_id` from the request body would let any member read another session's Tier-0 buffer and cached availability, and dodge the chat rate limit.
- F10 [major] The `_dispatch` change reaches every LiveKit tool; name the governed suites (`test:support`).

### Round 3 — CONVERGED
F9 closed (session_id dropped, a jest case proves the route ignores it). F10 acknowledged (global lang kept on purpose; test:support and the full suite in verification). Minor note taken: LiveKit navigator OASIS events stay ungrouped by session.
