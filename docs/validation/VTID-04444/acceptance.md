# VTID-04444 — Conversation rebuild WS-4.2: the nightly diary theme rollup

This is Plan v1 (Conversation Intelligence Rebuild), Phase 4, workstream WS-4.2. It ships in PR #3614 as a companion to VTID-04339.

VTID: VTID-04444
VALIDATION_PROFILE: gateway_backend

## Why

Loop 10 of the nightly consolidator (VTID-02632) was a stub. It counted yesterday's rows in `memory_diary_entries` and reported "LLM theme rollup deferred to brain unification".

Two facts found while building this, read-only against the live project (2026-09-23):

- **The stub counted the wrong table.** `memory_diary_entries` holds 1 row in total. The live diary is `diary_entries`: 273 rows from 22 users, 2 in the last 14 days. Loop 10's count had been measuring nothing.
- **The consolidator never runs on a schedule.** `consolidator_runs` has 2 rows, both `triggered_by = admin`, both on 2026-04-29. No cron, EventBridge job or automation calls `runConsolidator`. Only the admin smoke endpoint (`POST /admin/consolidator/run`) does.

The nightly profile (WS-4.1, VTID-04438) sees only the last 8 diary entries from 14 days, 300 characters each. Nothing summarised what a user keeps writing about over a month.

## Change

- **Rollup** (`services/memory/diary-theme-rollup.ts`):
  - **Who:** users with at least 3 entries in `diary_entries` over the last 30 days. Up to 20 entries each, 300 characters per entry, numbered oldest first.
  - **Model:** one call per user on the `memory` routing stage (Bedrock under the standing policy; no provider is named in code), `service: diary-theme-rollup`, 700 tokens max. Provider, model and latency are logged per call.
  - **What the model decides:** it names at most 6 themes and lists which numbered entries carry each one.
  - **What the code decides:**
    - It checks every entry number against the entries it sent. Out-of-range numbers are dropped, and so is a theme left with none.
    - Duplicate labels merge.
    - It computes each theme's count, last-seen date and trend from the entries' own dates: `rising` when more carrying entries fall in the last 7 days than before them, `fading` when none do, otherwise `steady`.

    So the model cannot invent a frequency.
  - **People** are kept only as lowercase relationship words (`partner`, `a colleague`). Anything capitalised, such as a name, is dropped by the code, not left to the prompt.
  - **Mood arc:** one sentence, at most 160 characters, or none.
  - **Storage:** `user_assistant_state`, signal `diary_themes_v1`, under the user's primary tenant (`diary_entries` carries no tenant). The value carries:
    - `schema_version`, `generated_at` and `inputs_hash`;
    - `window_days`, `entries_considered` and `theme_count`;
    - `themes`, `mood_arc` and `people`.
  - **Cost:** an unchanged inputs hash skips the user without a model call. A run stops at 25 model calls or 4 minutes. Users skipped as unchanged do not count against the cap, so the batch rotates.
  - **Nothing is spoken.** This is English data for the model's private context (NEVER-rule 41).
- **Loop 10** (`nightly-consolidator.ts`):
  - With `CONSOLIDATOR_DIARY_ROLLUP_ENABLED` exactly `true`, it runs the rollup with the run's scope and reports written / errors / outcomes.
  - Unset (or any other value), it is the previous count-only pass, byte for byte.
- **Schedule: AP-0915 "Diary Theme Rollup".**
  - Daily at 04:25 UTC, before the AP-0911 synthesis passes.
  - Registered in the automation registry and handled in `memory-intelligence.ts`.
  - The handler checks the same flag and does nothing without it.
  - It is listed as shadow-unsafe (it makes an LLM call) and added to `LEARNING_AUTOMATIONS`.
  - It has a line in `setup-eventbridge-cron-migration.sh` (the memory group, `--only autopilot-memory-`). That script is owner-run and was not applied.
- **Profile input** (`user-model-synthesis.ts`):
  - A fresh rollup (at most 14 days old) becomes a `DIARY THEMES` block in the synthesis prompt: each theme with its count and trend, the mood arc, and people by relationship.
  - The new rollup's `generated_at` enters the inputs hash only when a rollup exists. Profiles built without one keep their hash, so the deploy triggers no re-synthesis.
  - `inputs_counts.diary_themes` is recorded when a rollup was read (absent otherwise, so the stored shape is unchanged without one).
- **Command Hub → Assistant → Metrics (Learning health):** a "Diary themes (nightly rollup)" row with four tiles:
  - rollup on/off;
  - users with themes (average theme count);
  - fresh (≤ 14 days);
  - newest.

  The read goes through the route's repository seam, selects stamps and counts only (never the themes), and a failed read is reported in `errors` instead of failing the page.
- **Flag:** `CONSOLIDATOR_DIARY_ROLLUP_ENABLED`, documented in `.env.example`. **Not pinned on any deploy workflow**; a test asserts that.

## Acceptance

| AC | Check | Evidence |
|---|---|---|
| AC-1 | Flag off by default; only exact `true` enables | TEST: services/gateway/test/services/memory/diary-theme-rollup.test.ts (flag); services/gateway/test/vtid-04444-consolidator-diary-loop.test.ts ("any other value leaves it off", "is not pinned on any deploy workflow") |
| AC-2 | Flag off: loop 10 is the previous count-only pass, unchanged | TEST: services/gateway/test/vtid-04444-consolidator-diary-loop.test.ts ("flag unset: the previous count-only pass") |
| AC-3 | Flag on: loop 10 runs the rollup with the run scope and reports its outcome | TEST: services/gateway/test/vtid-04444-consolidator-diary-loop.test.ts ("flag \"true\"") |
| AC-4 | Counts, last-seen and trend come from the entries, not the model; bad entry numbers and empty themes are dropped | TEST: services/gateway/test/services/memory/diary-theme-rollup.test.ts (parseDiaryThemeOutput) |
| AC-5 | People are relationship words only; names are dropped | TEST: services/gateway/test/services/memory/diary-theme-rollup.test.ts ("keeps relationship words and drops names") |
| AC-6 | Too few entries, unchanged inputs, a failed read and a failed/empty model answer never write | TEST: services/gateway/test/services/memory/diary-theme-rollup.test.ts (rollupDiaryThemesForUser) |
| AC-7 | Stored under the primary tenant; tenant filter, model-call cap and scope honoured | TEST: services/gateway/test/services/memory/diary-theme-rollup.test.ts (runDiaryThemeRollup) |
| AC-8 | The profile synthesis reads a fresh rollup; without one, prompt and hash are unchanged | TEST: services/gateway/test/vtid-04444-consolidator-diary-loop.test.ts (profile synthesis input); services/gateway/test/services/user-model-synthesis.test.ts (unchanged, green) |
| AC-9 | AP-0915 registered, handled, shadow-unsafe, in learning health, and in the EventBridge memory group | TEST: services/gateway/test/vtid-04444-consolidator-diary-loop.test.ts (AP-0915 scheduling); services/gateway/test/vtid-04349-automation-shadow.test.ts; services/gateway/test/vtid-04226-eventbridge-test-contract-schedules.test.ts; services/gateway/test/vtid-04352-eventbridge-only-filter.test.ts |
| AC-10 | Learning health returns diary coverage from stamps only, and a failed diary read never fails the page; the diary row renders at 1400×900 and 390×844 with no horizontal overflow and no page errors | TEST: services/gateway/test/routes/vtid-04371-conversation-metrics-routes.test.ts ("reports diary theme coverage"); `outputs/learning-desktop.png`, `outputs/learning-mobile.png`, `outputs/shoot-report.json` (harness: `outputs/harness-server.js`, synthetic stamps only) |
| AC-11 | Live: with the flag set on staging, one AP-0915 run writes `diary_themes_v1` rows, and the next AP-0911 pass records `inputs_counts.diary_themes > 0` | **Not run.** Staging ECS cannot place tasks (AWS account block), and the flag is an owner decision (below). |

## Owner decisions (not taken here)

1. **Diary text to the `memory` stage, nightly.**
   - WS-4.1 already sends the last 8 diary entries (300 characters each) to the same stage.
   - This sends up to 20 per user per changed day.
   - The prompt keeps sensitive matters general, and the code drops names.
   - Whether the rollup runs at all is the flag.
2. **Scheduling.** Two changes are needed before it runs anywhere:
   - `setup-eventbridge-cron-migration.sh --only autopilot-memory- --apply` creates the AP-0915 schedule. The memory group now has 10 jobs.
   - The flag must be set on the task definition.
3. **The consolidator's other six loops still have no schedule.** That is unchanged by this VTID and outside its scope. AP-0915 schedules only the diary loop.

## Not changed

- The other consolidator loops.
- `memory_diary_entries` and its writer.
- The admin smoke endpoint.
- Every deploy workflow.
