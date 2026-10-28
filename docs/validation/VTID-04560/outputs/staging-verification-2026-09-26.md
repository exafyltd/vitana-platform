# VTID-04560 program — full staging verification, 2026-09-26

Owner request: run the full test suite of every development in the plan on
staging and confirm each one. Program = VTID-04560 (Phase 0) → VTID-04565
(Phase 5); acceptance criteria AC-1…AC-11 in `../acceptance.md`.

Staging served `11d116b1` (gateway) during the live runs — 33 commits ahead of
production `9ec2c640` — and the frontend `0ab62767`. Production was not
touched by any test (CLAUDE.md absolute rule). Test identity: the documented
test user (exafy_admin), every write it made recorded and reverted below.

## 1. Automated suites at the deployed commits

| Suite | Result |
|---|---|
| Gateway `tsc --noEmit` @ 9ec2c640 | clean |
| Gateway full Jest @ 9ec2c640 | 1,297/1,297 suites, 20,817 tests passed, 0 failed |
| `npm run test:roles` (standing rule 42h) | 97/97 (104/104 with this PR's additions) |
| `npm run test:operator` (42e) | 21/21 |
| `npm run test:support` (42c) | 82/82 (4 suites) |
| AC-3/AC-4 suites (payload identity, codebase overview, bootstrap pack) | 48/48 |
| Frontend Vitest @ 0ab62767 | 186/186 files, 1,122 tests |
| Frontend `tsc` / ESLint | 166 / 1,117 pre-existing errors; **0** in files the program changed except 4 `no-explicit-any` in `useOrbVoiceWidget.ts` that predate it (same 4 before, blame 2026-09-17) |
| Fix branch (this PR): tsc + full Jest | clean; 1,332/1,332 suites, 21,423 tests, 0 failed |

## 2. Live on staging

### AC-1/AC-2 — profile and greeting per surface (8 voice sessions, greeting only)

| Scenario | Profile resolved | Opener | Greeting |
|---|---|---|---|
| anonymous, community | vitanaland / anonymous | legacy_default | member welcome ✔ |
| anonymous, declares Command Hub | vitanaland / anonymous | (re-run) member welcome | ✔ never developer |
| signed in, community | vitanaland community declared | member rung | "…Tagebucheintrag…" ✔ |
| developer role on community screens | vitanaland community **narrowed** | conv_resume | member content ✔ |
| Command Hub | command-hub developer declared | work_surface_open | "Dev-Autopilot … 3 % … eine Ausführung wartet auf Ihre Freigabe" ✔ |
| Command Hub, no declaration (route) | command-hub developer route | work_surface_open | same ✔ |
| BackOffice | backoffice backoffice declared | work_surface_open | briefing items ✔ (4/4 runs) |
| Admin | admin admin declared | work_surface_open | **✘ canned apology 3 of 4 runs** → VTID-04654 |

First run: 2 of 8 sessions resolved their profile and then produced nothing
(no greeting_sent). Re-run of both: 3/3 correct. Recorded, not reproduced.

### AC-5 — one role truth (live RPC round trip, test user, restored)

Before fix: `me_set_active_role('developer')` → `{ok:true, tenant_id:null}`,
`user_active_roles=developer`, `role_preferences=community` **✘**. One real
user had drifted the same way (2026-09-25 18:35). → VTID-04655, applied live.
After fix: `developer`/`developer`, `preference_tenant_id=2e7528b8…` ✔;
restored `community`/`community`; drift count 0.

### AC-6 — what each app declares (Playwright, session start intercepted and aborted)

| Page | Viewport | surface / view_role (start and prewarm) |
|---|---|---|
| community /home | 1400×900, 390×844 | vitanaland / community ✔ |
| community after SPA route change → /comm/events-meetups | 1400×900 | vitanaland / community, `current_route=/comm/events-meetups` ✔ |
| /admin/dashboard (admin role active) | 1400×900, 390×844 | admin / admin ✔ |
| Command Hub | 1400×900, 390×844 | command-hub / developer ✔ |

### AC-7/AC-8/AC-9/AC-10 — Operator Console, 69-question evaluation set

Run with the test user's bearer (the machine-token secret is denied to this
session). First attempt: **69/69 HTTP 400** — the shipped eval script sends a
non-UUID `threadId` → VTID-04656. With UUIDs:

- 69/69 answered (HTTP 200), all on Bedrock `eu.anthropic.claude-sonnet-4-6`.
- 57/69 cite a source (file, table, VTID, event, commit).
- Tools used: dev_read_file 71, dev_search_codebase 39, knowledge_search 34,
  dev_index_query 23, dev_run_sql_readonly 18, **dev_domain_atlas 15,
  dev_deep_dive 9, dev_system_status 6**, CloudWatch/ECS 8 (these returned the
  known IAM denial verbatim — owner-gated grant, not part of this program).
- Deep dives: 9 `orb.deep_dive.completed`, 0 failed, avg 38.8 s, max 47 s
  (budget 150 s), max 12 tool calls (cap 12), max 6 turns (cap 10), all on the
  `planner` stage (Bedrock Opus 4.5).
- The set's "expected first tool" was used on 21/69 turns: the model often
  reaches the answer through code search/read instead of the atlas. No pass
  threshold exists for live tool choice (AC-10's threshold is the offline atlas
  routing, 69/69); recorded as a tuning signal, not a failure.

### AC-11 — customer support and operator pipelines

Green in §1 (82/82, 21/21).

## 3. Defects found → fixes (this PR)

| VTID | Defect | Fix | Verified |
|---|---|---|---|
| VTID-04654 | Admin opener apologises (instruction/directive conflict); briefing instruction served as a fact, insight 3 dropped | Admin tools line says the briefing is loaded; `briefingHighlights` takes numbered insights | unit + mutation; live after deploy |
| VTID-04655 | `me_set_active_role` never wrote `role_preferences` | Preference-tenant fallback, auth unchanged; drift re-aligned | live ✔ |
| VTID-04656 | Live eval script → 400 on every question | `randomUUID()` | live ✔ (69/69 with the same request shape) |

## 4. Writes by this verification, all reverted

- Role rows of the test user (4 switches) → restored `community`/`community`.
- 69 `operator_threads`, 375 `operator_messages`, 75 turn-extracted
  `dev_agent_memory` rows (all operator traffic in the window was this run's)
  → deleted.
- Voice sessions write only telemetry (`oasis_events`); `lang=de` matched the
  account's stored language, so no memory fact was written.
- Another session used the same test account concurrently (a headless browser
  switched it to `developer` at 14:32:54) — noted because it can confound runs.

## 5. Not verifiable here

- Spoken audio (needs a real device).
- Production: no test runs against production by rule.
