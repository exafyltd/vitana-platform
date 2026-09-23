# VTID-04323 — Vitanaland memory system: audit, plan, Phase 0

Plan: `docs/MEMORY-SYSTEM-PLAN.md`. Owner decisions answered 2026-09-23:
1. delete Cognee + Mem0, no replacement;
2. Titan V2 as the single embedder, re-embed;
3. transcripts kept 90 days;
4. isolated test DB in AWS.

Phase 0 is split across companion VTIDs, all in this PR:
- VTID-04341: fact churn
- VTID-04342: embeddings
- VTID-04343: diary
- VTID-04344: Cognee/Mem0 removal
- VTID-04345: memory health check

## Acceptance

AC-1: `write_fact()` does not insert a new row when the current fact already has the same value (trimmed, case-insensitive) and the incoming source is not stronger. A stronger source upgrades; a changed value supersedes. (VTID-04341)
TEST: local Postgres 16 run recorded in outputs/live-db-verification.md (3 cases). Applied live; `_memory_provenance_rank` present in the live body.

AC-2: user-memory embeddings come only from Amazon Titan V2 (1024-dim). No OpenAI or Google call remains on the fact-embedding path, and a per-text failure is returned as a null slot. (VTID-04342)
TEST: services/gateway/test/services/memory-facts-service-embeddings.test.ts
TEST: services/gateway/test/inline-fact-extractor-deepseek.test.ts (the Google `:embedContent` carve-out removed; any Google call now fails the test)

AC-3: `memory_items.embedding` and `memory_facts.embedding` are `vector(1024)` with HNSW indexes. The semantic-memory routes and the admin backfill embed with the memory embedder. (VTID-04342)
TEST: services/gateway/test/services/supabase-semantic-memory.test.ts
TEST: services/gateway/test/routes/semantic-memory.test.ts
Live check recorded in outputs/live-db-verification.md.

AC-4: the broker's episodic ladder runs `memory_items` semantic search first. It never queries `mem_episodes_semantic_search`, whose 1536-dim vectors come from a dead provider. It falls through to recency and then REST on an empty result or an error. (VTID-04342)
TEST: services/gateway/test/services/memory-broker-episodic-fallback.test.ts

AC-5: AP-0910 embeds the NULL backlog of both `memory_facts` and `memory_items`, skips blank content, and leaves rows NULL for the next run when Bedrock is unavailable. (VTID-04342)
TEST: services/gateway/test/services/automation-handlers-phase2.test.ts

AC-6: the DIARY block merges `diary_entries` (the app's Daily Diary) with `memory_diary_entries`, newest first, and one missing table does not blank the other. (VTID-04343)
TEST: services/gateway/test/services/memory-broker-diary-merge.test.ts

AC-7: the Cognee extractor, its gateway client, the `/relationships/from-cognee` route and the Mem0 memory-indexer client are removed. Supabase-only memory behaviour is unchanged. (VTID-04344)
TEST: services/gateway/test/services/session-memory-commit.test.ts
TEST: services/gateway/test/services/memory-source-config.test.ts
TEST: services/gateway/test/routes/admin-memory-broker.test.ts

AC-8: the morning health check gains check 21, which reads `ci_memory_health()` (service_role only, counts only). The self-audit stays last as check 22, and TOTAL_CHECKS is 22. (VTID-04345)
TEST: services/gateway/test/vtid-04345-morning-memory-check.test.ts

## Phase 1 acceptance (VTID-04364 / 04365 / 04366 / 04367)

AC-9: every gateway fact write goes through `rememberFact()`: Identity Lock → `write_fact` → async embedding. No other source file calls the `write_fact` RPC. The inline extractor, intent hooks, diary extractor and memory-intelligence handlers all use it. (VTID-04364)
TEST: services/gateway/test/services/memory/remember.test.ts
TEST: services/gateway/test/services/memory-facts-service.test.ts
TEST: services/gateway/test/services/automation-handlers-memory-intelligence-repository.test.ts

AC-10: every session end (WS cleanup, SSE stop/close, upstream disconnect, `/end-session`, `/session/finalize`, LiveKit commit-memory) calls `commitSessionMemory()` once per session. A session with ≥ 2 user turns gets one `session_summary` episode, written by the `memory` stage and idempotent both in process and through `uq_memory_items_session_summary` (applied live). (VTID-04365)
TEST: services/gateway/test/services/session-memory-commit.test.ts
TEST: services/gateway/test/routes/orb-livekit.test.ts

AC-11: the broker's EPISODIC block reads only `memory_items`, and the SEMANTIC block reads current `memory_facts`. The gateway no longer writes or reads `mem_facts` / `mem_episodes`, and the tier-2 writer modules are deleted. (VTID-04366)
TEST: services/gateway/test/services/memory-broker.test.ts
TEST: services/gateway/test/services/memory-broker-episodic-fallback.test.ts
TEST: services/gateway/test/services/orb-memory-bridge.test.ts

AC-12: `memory_items.active_role` is NULL for personal roles and holds the role otherwise. Episodic reads pass the role (lens role first) to `memory_semantic_search` and to the REST fallback, so memory written in a work role is visible only in that role. (VTID-04367)
TEST: services/gateway/test/services/memory-broker-episodic-fallback.test.ts
TEST: services/gateway/test/services/orb-memory-bridge.test.ts
TEST: services/gateway/test/orb/live/session/upstream-message-handler.test.ts

Phase 1 verification:
- `tsc --noEmit` is clean.
- Full gateway jest: 1099 of 1100 suites pass (1 skipped); 17,799 tests pass, 0 fail (`outputs/jest-full-phase1.txt`).
- Live read-only checks: `memory_semantic_search` has `p_active_role` / `p_max_age_hours` and filters `active_role IS NULL OR = p_active_role`; all 3,183 existing `memory_items` rows have `active_role` NULL (so nothing becomes hidden); the `session_summary` category and unique index exist.

Not verified in Phase 1:
- No session summary has been written on staging yet.
- The first live signal is a `memory.session.summarized` OASIS event after this deploys to staging.
- `mem_tier2_dual_write_enabled` and the relationship-edge mirror trigger stay in place while production still runs the old reader.

## Phase 2 acceptance (VTID-04387 / 04388 / 04389 / 04390 / 04391 / 04392)

AC-13: every raw user/assistant turn written through `writeMemoryItemWithIdentity` is also recorded in `memory_transcript_turns`. Recent-turn grounding and transcript rebuilds read that table first, and pg_cron deletes rows older than 90 days. `MEMORY_RAW_TURNS_TO_ITEMS=false` stops the memory_items copy. (VTID-04387)
TEST: services/gateway/test/services/memory/transcript.test.ts
TEST: services/gateway/test/services/orb-memory-bridge.test.ts

AC-14: the Garden API lists current facts plus non-raw episodes in 13 categories. User edits win: facts go through rememberFact with `user_stated_via_memory_garden_ui`, and forgetting a fact deletes its whole key history. Every query is filtered by the JWT tenant and user. (VTID-04388)
TEST: services/gateway/test/services/memory/garden.test.ts
TEST: services/gateway/test/routes/memory-garden.test.ts

AC-15: the Garden UI (vitana-v1#1132) reads and writes only through the Garden API. Its progress counts the real entries per category, and the legacy tables, `user_memory_metadata` and the Gemini edge functions are not referenced. Legacy `ai_memory` and diary content was copied into `memory_items` (applied live, 0 notifications). (VTID-04389)
TEST: vitana-v1 src/hooks/useMemoryMetadata.garden.test.ts

AC-16: one diary write path. `POST /api/v1/memory/diary/entries` writes the diary row, one diary episode (importance ≤ 50) and the Index sync; delete removes both. All 5 frontend writers use it. (VTID-04390)
TEST: services/gateway/test/services/memory/diary.test.ts
TEST: services/gateway/test/routes/memory-garden.test.ts

AC-17: AP-0914 writes at most one localized `daily_learning` episode per user per local date. It runs in the user's local 22:00 hour, is skipped in shadow mode, and is read by `GET /api/v1/memory/daily-learning` and the Daily summary screen. (VTID-04391)
TEST: services/gateway/test/services/memory/daily-learning.test.ts
TEST: services/gateway/test/vtid-04349-automation-shadow.test.ts

AC-18: the golden recall eval covers:
- fact recall and supersession
- session summary, daily learning and diary recall
- role scope in both directions
- cross-user isolation
- Garden forget
- the Garden never listing raw turns

It fails the build on any regression, and was mutation-verified. (VTID-04392)
TEST: services/gateway/test/memory-golden-eval.test.ts

Live changes made in Phase 2 (all additive except the purge):
- tables `memory_transcript_turns` and `purge_memory_transcript_turns` (daily);
- categories `daily_learning` plus the 13 Garden keys, the `personal` mapping, and index `uq_memory_items_daily_learning`;
- copies of about 370 raw turns (last 90 days), 112 `ai_memory` notes and 273 diary entries.

Before the copy I checked `trg_notify_memory_garden`, which notifies above importance 50. All copied and automatic rows are ≤ 50, and `memory_garden_grew` notifications created during the copy: 0.

Not verified in Phase 2:
- The endpoints are not deployed anywhere yet.
- The UI was verified locally with every network call intercepted (screenshots at 1400×900 and 390×844).
- AP-0914 needs the EventBridge schedule, which is owner-run.

## Phase 3 acceptance (VTID-04407 / 04408 / 04409)

AC-19: `dev_agent_memory` has `author_user_id` and a `handoff` category (applied live, 219 existing rows untouched). `write_dev_memory()` is one overload, executable by `service_role` only. `recall_dev_memory()` leaves handoffs out unless they are asked for. (VTID-04407)
TEST: services/gateway/test/services/dev-agent-memory.test.ts

AC-20: the hourly handoff sweep writes one handoff per owned Operator thread that has been quiet for 60 minutes.
- The handoff is written by the `memory` stage, tagged `thread:<id>`, with the thread's VTIDs.
- It supersedes the thread's previous handoff.
- It is skipped when the thread has no owner, when the latest handoff is already newer than the last message, or when the model answers NONE.
- A failed model call or write is counted, never thrown.
(VTID-04407)
TEST: services/gateway/test/services/dev-memory/handoff.test.ts
TEST: services/gateway/test/vtid-04226-eventbridge-test-contract-schedules.test.ts

AC-21: `GET /api/v1/dev-memory/morning-pack` returns:
- the caller's handoffs from the last 7 days (an admin session gets its own; the pack token may name an author);
- repo-wide decisions/incidents/gotchas/conventions from the last 7 days;
- VTIDs in progress.

Each section fails open with its reason listed. `?format=text` is capped at 8 KB. The read-only `X-Dev-Memory-Token` cannot trigger the sweep. (VTID-04408)
TEST: services/gateway/test/services/dev-memory/morning-pack.test.ts
TEST: services/gateway/test/routes/dev-memory.test.ts

AC-22: `GET /api/v1/operator/threads` lists only the caller's own threads (exafy_admin), newest activity first, with summaries clipped. A caller without a UUID identity has no threads. The route is registered before `/threads/:threadId/messages`. (VTID-04409)
TEST: services/gateway/test/vtid-04409-operator-thread-list.test.ts

Not done in Phase 3, owner steps:
- The SessionStart hook script `.claude/hooks/session-start-dev-memory-pack.sh` exists and is tested (bash -n, and it skips cleanly without a token). Registering it in `.claude/settings.json` was refused to this session as self-modification, so the owner adds the entry.
- `DEV_MEMORY_PACK_TOKEN` has to be set in the staging gateway task def and in the Claude Code environment. Until then the hook prints nothing.
- The sweep schedule runs only after `setup-eventbridge-cron-migration.sh --apply`.
- The Command Hub thread-list UI is not built. It needs a Command Hub ownership allowlist entry.

## OASIS

OASIS_PROOF:
- New (Phase 3): `dev_memory.handoffs.written`, emitted only when a sweep wrote at least one handoff (candidates, outcomes, written).
- New (Phase 2): `memory.garden.edited`, `memory.diary.saved`, `autopilot.memory.daily_learning_written` (outcome counts per run).
- `memory.session.summarized` (new, VTID-04365) is emitted once per written session summary, with session id, channel, trigger, memory_item_id and provider. `orb.live.memory.committed` now carries `summary_queued`.
- `autopilot.memory.embeddings_backfilled` (emitted by AP-0910) now carries `model`, `facts_embedded`, `facts_failed`, `items_embedded` and `items_failed`. It is emitted only when something was attempted.
- The five `cognee.extraction.*` event types are removed; nothing emitted them since 2026-04-29.
- Covered by `automation-handlers-phase2.test.ts` (AP-0910) and `tsc --noEmit` (event type union).

## Not verified here, stated plainly
- No real Titan embedding was produced from this session: `claude-code-aws-agent` gets `Operation not allowed` on `bedrock-runtime:InvokeModel`. The gateway task role already embeds `dev_agent_memory` with the same model (219 of 219 rows).
  - The first live signal is `embedding_updated_at` populating on staging after deploy, and `ci_memory_health().items_embedded_2h > 0`.
- AP-0910 has no running scheduler: AP-09xx last ran 2026-07-06. The backlog drains through embed-on-write for new rows, plus manual AP-0910 runs, until `scripts/aws/setup-eventbridge-cron-migration.sh --apply` is run by an admin.
- `vitana-memory-test` (RDS) is not created: `rds:CreateDBInstance` was denied for this session. `scripts/aws/setup-memory-test-db.sh --apply` is owner-run.
- The `vitana-cognee-extractor` ECS service (already 0 tasks) is not deleted. `scripts/aws/retire-cognee-extractor.sh --apply` is owner-run.

## Route mount evidence (new routes in Phase 2)

ROUTE_MOUNT: `services/gateway/src/index.ts` → `mountRouterSync(app, '/api/v1', memoryGardenRouter, { owner: 'memory-garden' })` (router `services/gateway/src/routes/memory-garden.ts`, all routes behind `requireAuthWithTenant`)

FINAL_URL:
- `GET  /api/v1/memory/garden/entries`
- `GET  /api/v1/memory/garden/categories`
- `POST /api/v1/memory/garden/entries`
- `PATCH /api/v1/memory/garden/entries/:kind/:id`
- `DELETE /api/v1/memory/garden/entries/:kind/:id`
- `POST /api/v1/memory/diary/entries`
- `DELETE /api/v1/memory/diary/entries/:id`
- `GET  /api/v1/memory/daily-learning`

CURL_PROOF: **not yet run.** The routes are new and deployed nowhere, so there is nothing to curl before merge. Writing down a response now would be invented evidence.
- **Before merge (now):** `services/gateway/test/routes/memory-garden.test.ts` mounts the real router with supertest and checks 401 without identity, 400 on invalid input, 200/201 JSON on success and 404/502 pass-through.
- **After the staging deploy:** this read-only check needs no token. The expected answer is `401 application/json` (route exists); `404 text/html` would mean it did not deploy.

  ```
  curl -s -o /dev/null -w "%{http_code} %{content_type}\n" https://preview-aws-gateway.vitanaland.com/api/v1/memory/garden/categories
  ```

## Route mount evidence (new routes in Phase 3)

ROUTE_MOUNT:
- `services/gateway/src/index.ts` → `mountRouterSync(app, '/api/v1/dev-memory', devMemoryRouter, { owner: 'dev-memory' })` (router `services/gateway/src/routes/dev-memory.ts`)
- `services/gateway/src/routes/operator.ts` (already mounted at `/api/v1/operator`) → `router.get('/threads', requireAdminAuth, …)`

FINAL_URL:
- `GET  /api/v1/dev-memory/morning-pack`
- `POST /api/v1/dev-memory/handoffs/sweep`
- `GET  /api/v1/operator/threads`

CURL_PROOF: **not yet run.** These routes are new and not deployed anywhere, so a response written down now would be invented.
- **Before merge:** `test/routes/dev-memory.test.ts` mounts the real router (401 without credentials, 400 on a bad author, 200 JSON/text, pack token refused on the sweep). `test/vtid-04409-operator-thread-list.test.ts` covers the thread list.
- **After the staging deploy:** a check with no token; `401 application/json` means the route exists.

  ```
  curl -s -o /dev/null -w "%{http_code} %{content_type}\n" https://preview-aws-gateway.vitanaland.com/api/v1/dev-memory/morning-pack
  ```
