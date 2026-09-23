# Vitanaland Memory System — Audit & Plan (VTID-04323)

**Date:** 2026-09-23
**Scope:** both repos (`vitana-platform`, `vitana-v1`), plus read-only queries against the live database.
**Author:** Claude Code session, on the platform owner's request.

**Goal:** a memory system that a supervisor can maintain and that the team can rely on. Community users should notice it, and a developer should never start the day with an empty memory.

---

## 0. Verdict in five lines

1. **Too many parallel memory mechanisms.** There are at least **9** in the gateway, **2** more in the frontend, **1** for developers, and **2** instruction builders that each assemble memory into the prompt differently. Nobody can say which one is true, and that is the root problem, not Cognee.
2. **Cognee is already dead three ways.**
   - It has no URL on either gateway.
   - Its kill switch has been off since 2026-04-29.
   - Its ECS task has no LLM configured.

   An in-gateway extractor quietly replaced it months ago. **It does not need a replacement product. Delete it.**
3. **Semantic recall ("what's relevant to what the user just said") has not worked since late April 2026.** The embedding code calls OpenAI and Gemini, and neither key exists on AWS. That leaves 0 of 13,912 `mem_facts` rows and 0 new `memory_items`/`mem_episodes` rows embedded since 2026-04-28. The Bedrock Titan embedder that *does* work is used only for developer memory.
4. **What users see in the Memory Garden is not what Vitana remembers.**
   - The Garden reads the legacy tables `ai_memory` (last write 2025-11-10) and `diary_entries`.
   - ORB voice writes `memory_items` and `memory_facts`.
   - So a user never sees what Vitana learned in conversation, and the "daily summary" / "insights" screens are mock data.
5. **The fix is consolidation, not new technology.**
   - Keep one store: Postgres + pgvector, which we already run.
   - Keep one embedder: Bedrock Titan v2, already proven.
   - Keep one write API, one read API, one nightly job and one health check.

   At our scale (≈13k facts, ≈3k items, 228 users), Postgres is more than enough for years.

---

## 1. What is really there (evidence)

### 1.1 Live data (read-only queries, 2026-09-23)

| Store | Rows | Users | Last write | Status |
|---|---|---|---|---|
| `memory_facts` | 12,684 (only **918 active**) | 228 | today | **Live, but polluted.** 10,097 rows (80%) are `preferred_language` rewritten on every session. |
| `mem_facts` (tier-2 mirror) | 13,912 | — | today | Dual-write copy. **0 embeddings.** |
| `memory_items` | 3,183 | 72 | yesterday | Live. 2,014 rows are raw user turns (`orb_voice/conversation`). Last embedding written 2026-04-26. |
| `mem_episodes` | 5,338 | — | yesterday | Dual-write copy. Embeddings stop at 2026-04-28. |
| `diary_entries` | 273 | 22 | 2026-09-15 | Live. The UI writes it, but memory context shows `diary_loaded: 0` on every turn sampled. |
| `memory_diary_entries` | 1 | — | 2026-01-01 | Dead (second diary table). |
| `ai_memory` | 114 | — | 2025-11-10 | Dead writer. Still the table the **Memory Garden UI** reads. |
| `user_session_summaries` | 4 | 2 | 2026-04-28 | Effectively dead. |
| `relationship_nodes/edges` | 31 / 52 | — | 2026-07-06 | Tiny. `relationship_signals` has no writer since Cognee died. |
| `memory_write_dlq` | 70 | — | 2026-08-28 | Failed writes nobody replays (51 × FK violation on `mem_facts`). |
| `dev_agent_memory` | 219 | (global) | yesterday | **Healthy.** 100% embedded with Titan v2, real vector recall. |
| `operator_threads/messages` | 144 / 275 | — | live | Working, but the thread list lives only in browser localStorage. |

Feature switches (`system_controls`):
- `memory_broker_enabled`, `mem_tier2_dual_write_enabled`, `vitana_brain_enabled`, `vitana_brain_orb_enabled` and `tier0_redis_enabled` are all **on**.
- `cognee_extraction_enabled` is **off**.

Per-turn telemetry (`memory.orchestrator.context_built`, about 590 per 14 days): memory *is* injected into the prompt on every sampled turn (11–23 facts, 2–8 episodic items). However, `diary_loaded` is 0 and `recent_turns_loaded` is 0 on every sampled turn.

### 1.2 The mechanisms (gateway)

1. `memory_items`: raw user turns plus notes.
2. `memory_facts` + `write_fact()`: key/value facts with supersession.
3. Tier-2 `mem_episodes` / `mem_facts` / `mem_graph_edges`: dual-write mirrors, read first by the memory broker.
4. `relationship_*` graph: written by Cognee (dead) and a nightly rebuild (AP-0909).
5. Two diary tables.
6. `user_session_summaries`: effectively unused.
7. `session-memory-buffer` + Redis turn buffer (in-session).
8. Mem0 `memory-indexer-client`: deprecated but still imported in `orb-live.ts`.
9. `social-memory/*`: reads `chat_messages`.
10. (Frontend) the `ai_memory` table plus 6 Gemini edge functions (`ai-chat`, `extract-diary-insights`, `generate-memory-embedding`, `search-memories`, …).
11. (Dev) `dev_agent_memory` + `operator_threads`: separate and healthy.

There are also **two prompt builders**: the legacy `orb-memory-bridge` bootstrap and the `vitana-brain` / `memory-orchestrator` path.

### 1.3 Concrete defects found

| # | Defect | Where | Effect |
|---|---|---|---|
| D1 | Embeddings call OpenAI → Gemini; neither key is on AWS | `embedding-service.ts:238-290`, `memory-facts-service.ts:644-731` | No semantic recall since April. Retrieval falls back to "most recent" only. |
| D2 | Vector sizes disagree: fact search sends 1536 numbers into a 768-number column/RPC; migrations disagree on `memory_items` | `memory-facts-service.ts:519-537`, migrations `20260221…768` vs `20260427…float8` | Fact semantic search fails on every call, silently (warning only). |
| D3 | `preferred_language` is rewritten on every session | orb-live language preference → `writeFact` | 80% of fact rows are noise, and the supersession history is useless. |
| D4 | Garden UI reads `ai_memory` / `diary_entries`; voice writes `memory_items` / `memory_facts` | `vitana-v1/src/hooks/useKnowledgeBase.ts`, `useMemoryMetadata.ts` | Users never see what Vitana remembers, so there is no trust and no correction loop. |
| D5 | Garden category counting groups by `ai_memory.memory_type` (insight/pattern/…) as if it were a category | `useMemoryMetadata.ts:125` | Garden progress is wrong. |
| D6 | Diary is never loaded into context | broker DIARY block reads `memory_diary_entries` (1 row), not `diary_entries` | The daily diary has no effect on responses. |
| D7 | "Single" session-end commit is implemented three times | `session-memory-commit.ts` (LiveKit only), `live-session-controller.ts:2436-2492`, `orb-live.ts` | Drift between transports; LiveKit has no per-turn transcript. |
| D8 | Inline extractor bypasses `writeFact` | `inline-fact-extractor.ts:281` | Facts miss the mirror → the two fact tables diverge (that divergence is also what created the DLQ). |
| D9 | Memory reads ignore the role (`p_active_role: null`) | `memory-broker.ts:549,685` | The "scope by tenant + role" rule (CLAUDE.md ALWAYS 28) is not enforced. |
| D10 | `/health` of cognee-extractor says healthy even when extraction is broken | `cognee-extractor/main.py:27-44` | Typical of why Cognee "kept breaking" invisibly. |
| D11 | Dev memory has no author, and there is no per-developer "what I did yesterday" | `dev_agent_memory` schema, Operator thread index in localStorage | A developer on a new browser or new day starts cold; Claude Code sessions never read it. |
| D12 | Frontend memory edge functions still run on Gemini | `vitana-v1/supabase/functions/*` | These break against the "no Google" rule, and `ai-chat` still writes the legacy tables. |

### 1.4 Why Cognee kept failing (so we don't repeat it)

Traced from 62 commits:
- Its SDK API changed between versions and crashed production (2026-03-17).
- Heavy Python dependencies failed at startup.
- LLM and auth were bound to GCP.
- It ran on internal-only ingress, so CI could not probe it.
- Its `/health` hid failures.
- It **wrote into the same tables** as the inline extractor (dual-write drift).
- It rebuilt and pruned a whole graph on every request.

**The lesson is general:** every extra service and every dual write is a new place for memory to fail silently. That applies to Mem0 and the tier-2 mirrors just as much.

---

## 2. Should we replace Cognee with another product?

**No.** Options considered:

| Option | What it brings | Why not for us |
|---|---|---|
| Mem0 (hosted or self-hosted) | Fact extraction + vector recall | **We already tried it here and deprecated it** (`MEMORY_SOURCE=mem0`). It is one more service and one more copy of user data. |
| Zep / Graphiti | Temporal knowledge graph | Needs Neo4j/FalkorDB: a new database to run, secure and back up. The graph is overkill for 228 users. |
| Letta (MemGPT) | Agent-managed memory | It owns the agent loop. We have our own (Nova / cascade / Bedrock), so it would fight our architecture. |
| AWS Bedrock AgentCore Memory | Managed short/long-term memory | Promising and AWS-native. But it would be a second source of truth beside Postgres, and the Memory Garden must be editable by users. **Worth a re-evaluation in 6 months, not now.** |
| **Postgres + pgvector + Titan v2 (build on what we have)** | Facts, episodes, vector recall, RLS, tenant scoping, one backup | Already running and already proven for dev memory. Our extraction already runs in-gateway through `callViaRouter('memory')` on Bedrock. **Recommended.** |

What made Cognee attractive was graph reasoning about relationships. We can get that far more simply:
- Relationship facts are ordinary facts (`friend_name`, `child_name`, `partner_*`) with an `entity` field.
- The existing nightly job keeps `relationship_nodes/edges` as a *derived* view for the Network UI.

---

## 3. Target architecture (simple on purpose)

### 3.1 Four kinds of memory, two tables, one scope rule

| Kind | What it is | Stored as | Example |
|---|---|---|---|
| **Profile facts** | Stable, key-value, one current value | `memory_facts` (canonical) | name, birthday, child_name, goal, medication, language |
| **Episodes** | Something that happened, as a short summary | `memory_items` (canonical) | session summary, diary entry, daily learning, manual Garden note, resolved support ticket |
| **Session memory** | The live conversation, short-term | In-process / Redis buffer; raw transcript table with TTL | the last N turns of the current session |
| **Derived views** | Computed, never written by hand | Nightly job output | relationship graph, Garden progress, Vitana Index inputs |

Every row in `memory_facts` and `memory_items` gets one scope field:

```
scope = 'user'            -- personal memory (default; owned by user_id)
      | 'role:<role>'     -- shared by everyone in that role within a tenant (e.g. role:developer, role:support, role:backoffice)
      | 'customer:<id>'   -- attached to an ERP/CRM customer record (tenant-scoped)
```

Plus the existing `tenant_id`, `user_id` (author), `source`, `provenance_source` (`user_stated` > `user_edited` > `assistant_inferred` > `system_observed`), `importance`, and an `embedding vector(1024)` (Titan v2).

`dev_agent_memory` stays as the **role:developer store**. It already works and already has the right shape. Phase 3 only adds `author_user_id` and a handoff category. We do not force it into the community tables.

### 3.2 One write API — `memory.remember()`

A single gateway module, `services/memory/` (new home; old files are deleted as they are absorbed):

```
remember.fact({ tenant, user, scope, key, value, provenance, source })   -> write_fact() ; skip if value unchanged
remember.episode({ tenant, user, scope, kind, text, occurred_at, source }) -> memory_items + Titan embedding (sync, fail loud → DLQ with retry)
```

Callers are exactly these, and nothing else writes the memory tables:

| Trigger | Writes |
|---|---|
| Session end (**all** transports — one shared function) | 1 session-summary episode + 0–N facts (the existing `deduplicatedExtract` on the `memory` stage) |
| Memory Garden manual add/edit/delete (via gateway API, not direct Supabase) | episode or fact, `provenance=user_stated`, always wins |
| Diary entry saved (all 4 frontend writers → one gateway endpoint) | episode `kind=diary` + optional health facts |
| Nightly job per active user | 1 `daily_learning` episode (what changed today, from diary + sessions) |
| Support ticket resolved | episode `kind=support`, scope `user` + `role:support` summary |
| BackOffice CRM note / call | episode, scope `customer:<id>` |

Raw user turns stop being "memory items". They go to a transcript table with 30–90-day retention and are used only to build the session summary. This removes about 2/3 of `memory_items` noise and makes recall sharper.

### 3.3 One read API — `memory.recall()`

```
recall({ tenant, user, active_role, query, budget_chars }) -> MemoryContext {
  profile:   top current facts (always; ~1.5 KB; importance-ordered)
  recent:    last 3 session summaries + today's diary/daily-learning (~1.5 KB)
  relevant:  vector top-k over episodes+facts for `query` (~2 KB, category-diverse — reuse dev-memory-ranking.ts)
  open:      active goals / open commitments / follow-ups (~0.5 KB)
  role:      if active_role ≠ community → role-scoped memory for that role (~1 KB)
}
```

Rules for `recall()`:
- It is the **only** function any prompt builder calls: voice (Nova/cascade/Vertex bridge), text chat, Operator Console and BackOffice assistant.
- It replaces both the `orb-memory-bridge` bootstrap and the brain/orchestrator assembly; one formatter renders it.
- Fixed section budgets, so it can never blow the 30 KB instruction budget.
- Each section is independent with its own timeout. A slow section is dropped and reported in `degraded_sources`, which already exists in telemetry; the session is never blocked.

### 3.4 What gets deleted (the balloon comes down)

- **Cognee:**
  - the service `services/agents/cognee-extractor/`
  - the client and tests
  - the `/relationships/from-cognee` route
  - the `cognee_extraction_requests` table
  - the ECS service `vitana-cognee-extractor` (an owner action)
- **Mem0:** `memory-indexer-client` and its `orb-live.ts` wiring.
- **Tier-2 dual write:** `mem_episodes` / `mem_facts` / `mem_graph_edges`, once the broker reads the canonical tables. This single step removes the dual-write drift and the DLQ's main source.
- **Legacy frontend memory:**
  - the `ai_memory` table (migrate 112 rows)
  - `memory_diary_entries` (1 row)
  - the Gemini edge functions `generate-memory-embedding`, `search-memories`, `reinforce-memory`, `extract-user-interests`, `extract-diary-insights`
  - the duplicate `refresh-memory-metadata` client logic
- **OpenAI/Gemini embedding paths.** Titan v2 is the only embedder, and it fails loudly.
- **Unused exports** in `orb-memory-bridge.ts` (8 functions) and `memory-facts-service.ts` (2).

Target: **about 40 memory files in the gateway → about 10**, **two memory tables plus one transcript table plus one dev table**.

---

## 4. Memory by audience

### 4.1 Community users (the heavy users)

What "impressed" means, and how the design delivers it:

| Moment | What Vitana does | Powered by |
|---|---|---|
| Opening | Greets with a real continuation: "Last time you said your knee hurt after the run — better?" | `recent` + `open` |
| Mid-conversation | Connects to something said weeks ago | `relevant` (working vector search) |
| Personal details | Never re-asks name, children, goals, medications | `profile` facts, provenance-ranked |
| Diary | Reflects the day's diary without being asked | diary episodes in `recent` |
| Daily learnings | The next morning: "Yesterday you slept 6h and skipped the walk — want a lighter plan?" | nightly `daily_learning` |
| Trust | The Memory Garden shows exactly what Vitana knows; the user can edit or delete it and Vitana respects that at once | Garden reads/writes the canonical store; `user_stated`/`user_edited` wins |

**Memory Garden** becomes the user's window into the same store:
- The 13 categories map from `category_key` / `fact_key`, which already exists in `memory_garden_config` and `memory_category_mapping`.
- Edits go through the gateway.
- Deleting a fact supersedes it and adds a "do not re-learn" marker, so the extractor does not re-infer it next session.

### 4.2 Developers (role memory)

Goal: **no developer starts a day with empty memory.**

1. **Personal handoff.** At the end of each Operator Console thread, and nightly per active developer, write a `handoff` row to `dev_agent_memory` with an `author_user_id`: what I worked on, what is open, what's next.
2. **Shared team memory.** The existing categories (decision / convention / incident / gotcha / task_outcome) stay global to `role:developer`. That is correct: a gotcha found by one developer protects all of them.
3. **Morning pack.** A new Operator thread, or a new Claude Code session, gets injected with:
   - "your last handoff"
   - "team changes since your last session"
   - the top-10 relevant memories (ranking already exists).
4. **Claude Code sessions.** A SessionStart hook in `.claude/hooks/` calls a read-only gateway endpoint (`GET /api/v1/dev-memory/morning-pack`) and prints the pack. Claude Code then starts with the same memory as the Operator Console. (At the moment Claude Code has only `CLAUDE.md`.)
5. **Server-side thread list.** Add `GET /api/v1/operator/threads` so threads follow the developer across browsers, not localStorage.

### 4.3 ERP & CRM — customer memory

- The ERP (ERPClaw) stays the system of record for customers, orders and activities. **Do not copy ERP data into memory.**
- Customer memory holds only what the ERP does not capture: soft context from calls, notes and BackOffice assistant conversations ("prefers email, was unhappy about the March delivery"). These are `scope=customer:<erp_id>` episodes, tenant-scoped, readable by `backoffice` / `staff` roles.
- The BackOffice assistant's `recall()` adds: the ERP facts (read via the existing bridge commands) plus the customer episodes.
- **Build this in Phase 4, after the community path is solid.**

### 4.4 Customer support memory

- Resolved ticket → one summary episode (problem, resolution, sentiment):
  - scoped `user`, so Vitana knows "your login issue from last week is fixed";
  - plus an anonymised `role:support` "known issue → fix" entry, so support personas learn recurring solutions.
- The current `build_specialist_context` (ticket counts) stays as the structured part.

---

## 5. Reliability — how we make it trustworthy

Memory failed here mostly **silently**. The plan makes every failure loud and measurable:

1. **One embedder, loud failure.**
   - Titan v2 only.
   - If embedding fails, the row is written without a vector and queued for retry.
   - The backlog count is on the health check.
   - We never fall back to a different provider with different dimensions.
2. **One daily memory health check**, added to `MORNING-SYSTEM-HEALTH-CHECK.yml` via a `ci_memory_health()` RPC, same pattern as `ci_vital_systems_health()`:
   - facts/episodes written in 24h
   - % embedded
   - session-end commits vs sessions ended
   - DLQ open count
   - % of `context_built` events with each section loaded
   - fact churn (writes per active fact)
3. **Golden recall evaluation.** A fixed script of synthetic conversations run against a local Supabase, never production:
   - "my daughter is Mia", then 3 sessions later "what's my daughter's name?"
   - diary says "bad sleep", next morning's greeting reflects it
   - user deletes a fact, and it is never repeated

   It runs in CI on every memory PR. This is the missing piece that made "we improved it" unverifiable.
4. **Idempotent session-end commit.** Keyed by `session_id`, safe to retry, identical for every transport.
5. **Single owner.** `services/memory/` has one README with the table list, the write callers and the read contract. It is short enough for a supervisor to read in 10 minutes.

---

## 6. Phased plan

Each phase ships independently to staging and is verified with the health check and the golden eval before the next starts. Each bullet becomes its own VTID/PR.

### Phase 0 — Stop the bleeding (≈1 week) — shipped 2026-09-23 in PR #3606
- [x] **D3 (VTID-04341):** `write_fact()` no longer re-inserts a same-value fact unless the source is stronger. Fixed in the database function, so it covers every writer, not only `preferred_language`. Applied live. The ~10k already-superseded rows are left alone: they are history, and deleting them is a separate decision.
- [x] **D1/D2 (VTID-04342):**
  - One memory embedder, Titan V2 1024-dim (`memory-embedding.ts`).
  - `memory_items`/`memory_facts` columns changed to `vector(1024)` and applied live.
  - Old vectors nulled.
  - Items are embedded on write.
  - AP-0910 drains both tables.
  - The broker now runs `memory_items` semantic search first (it never ran before).
  - The OpenAI/Gemini fact path is removed.
- [x] **D6 (VTID-04343):** the broker DIARY block merges `diary_entries` (the app's diary) with `memory_diary_entries`.
- [x] **Cognee + Mem0 removed (VTID-04344).** The ECS service `vitana-cognee-extractor` was already at 0 tasks; deleting it is `scripts/aws/retire-cognee-extractor.sh --apply` (owner-run, admin identity).
- [x] **`ci_memory_health()` + morning check #21 (VTID-04345)**, applied live. It is expected to FAIL until the re-embed backlog drains and AP-0910 is scheduled again (below).

**Found during Phase 0, owner action needed:** none of the memory-intelligence automations have run since July 2026: AP-0906..AP-0913, including graph projection, the AP-0910 embedding backfill and user-model synthesis. Their GCP Cloud Scheduler died with GCP. The AWS replacement (`scripts/aws/setup-eventbridge-cron-migration.sh`, VTID-04226) was prepared but never applied. Running it with `--apply` from an admin session restores them.

Separately, `POST /api/v1/automations/cron/:id` had no authentication. Fixed by VTID-04349 (`requireInternalOrAdmin`).

### Phase 1 — Consolidate (≈2–3 weeks)
- [x] `services/memory/remember.ts` — one fact write path; inline extractor, intent hooks, diary extractor and memory-intelligence all moved behind it (fixes D8). VTID-04364.
- [x] One session-end commit for all transports (WS cleanup, SSE stop/close, upstream disconnect, `/end-session`, `/session/finalize`, LiveKit) (fixes D7); session-summary episode per session, idempotent in process and by unique index. VTID-04365.
- [x] Broker reads the canonical tables; the gateway no longer writes the tier-2 mirrors. VTID-04366.
- [ ] Drop the mirrors, the relationship-edge mirror trigger and the flag after prod runs this code and 2 weeks of clean health checks; replay or close the DLQ.
- [x] Delete the unused bridge exports (scored/trust/enhanced instruction builders, ~875 lines; no caller in `src/` or `test/`). VTID-04364.
- [ ] Both prompt builders call one `recall()` — the context pack already reads through the broker; the ORB live prompt still uses `fetchMemoryContextWithIdentity`. Moving it changes what a live voice session hears and needs latency measurement on staging first, so it is its own step.
- [x] Role scope on write (`memory_items.active_role`) and on read (broker, context pack) (fixes D9). VTID-04367.

### Phase 2 — Make users feel it (≈2–3 weeks)
- [x] **Memory Garden on the canonical store:**
  - Gateway API `/api/v1/memory/garden/{entries,categories}` for list, add, edit and delete (VTID-04388).
  - vitana-v1 Garden hooks rebuilt on it; exafyltd/vitana-v1#1132 (VTID-04389).
  - `ai_memory` and diary entries copied into `memory_items` (applied live).
  - Category counting fixed (D4, D5).
  - The Garden no longer calls the Gemini edge functions. `ai-chat` (health coach) still uses them: part of D12 remains.
- [x] **Forgetting sticks (VTID-04441).** Deleting a fact in the Garden first records one `memory_fact_forgotten` marker per value (sha256 of the normalised value; the value is not kept). `rememberFact()` refuses an inferred write of a forgotten value, still learns a different value for the key, and clears the marker when the user states it again. A marker store that fails lets the write through and logs.
- [x] All 5 diary writers go through one endpoint, `POST /api/v1/memory/diary/entries`: diary row, memory episode and Index sync (VTID-04390).
- [x] Nightly `daily_learning` episode per active user (AP-0914, the user's local 22:00), and the real "Daily summary" screen replacing the mock (VTID-04391). The scheduler is the owner-run EventBridge `--apply`.
- [x] Raw transcripts go to `memory_transcript_turns` with a 90-day pg_cron purge; the last 90 days were backfilled (VTID-04387).
  - `memory_items` still also receives raw turns until `MEMORY_RAW_TURNS_TO_ITEMS=false` is set, after session summaries are observed live.
  - Deleting the 2,666 old raw-turn rows from `memory_items` is a follow-up for after that flip.
- [x] Golden recall eval in CI: `test/memory-golden-eval.test.ts` plus `test/fixtures/memory-golden/scenarios.json`. 10 scenarios; mutation-checked, and it fails when the superseded-fact or role filter is removed (VTID-04392).

### Phase 3 — Developer memory (≈1–2 weeks)
- [x] `author_user_id` + `handoff` category on `dev_agent_memory` (VTID-04407, migration `20260923190000`, applied live). One hourly sweep (`POST /api/v1/dev-memory/handoffs/sweep`, EventBridge job `gateway-dev-memory-handoff-sweep`) writes a handoff for every owned Operator thread that has been quiet for 60 minutes. That covers both end-of-thread and end-of-day. A newer handoff supersedes the older one, and a thread whose handoff is already current is skipped. Handoffs are left out of semantic recall; only the morning pack reads them.
- [x] `GET /api/v1/dev-memory/morning-pack` (VTID-04408). It returns the owner's handoffs from the last 7 days, the repo-wide decisions/incidents/gotchas/conventions from the last 7 days, and VTIDs in progress. `?format=text` returns plain text. Hook script: `.claude/hooks/session-start-dev-memory-pack.sh`, read-only through `X-Dev-Memory-Token`. **Owner step:** register the hook in `.claude/settings.json` (a session is not allowed to edit its own settings), then set `DEV_MEMORY_PACK_TOKEN` in the gateway task def and in the Claude Code environment.
- [x] Server-side Operator thread list: `GET /api/v1/operator/threads` (VTID-04409). The Command Hub sidebar merges it into the local thread index and loads a server-only thread's transcript on open (VTID-04437).

### Phase 4 — Customer & support memory (≈2 weeks, after Phase 2)
- [x] Customer-scoped episodes (VTID-04411, migration `20260923200000`, applied live). Every executed BackOffice CRM/sales command about a customer, lead, contact or opportunity leaves one `customer` episode.
  - It is written by the orchestrator after execution, on both the direct and the approved path.
  - Each episode is keyed by `content_json.customer_key`, with `active_role 'backoffice'` and importance 40, and is unique per command.
  - The text is built from the command's own fields, with no model call.
  - Recall: the BackOffice voice tool `backoffice_customer_memory` reads everything the tenant recorded about one customer. It needs `crm.view` or `sales.view`.
  - Personal recall and the Garden never see these episodes (golden eval scenario 11).
  - Not done: "assistant turns" as customer episodes. BackOffice voice turns are not tied to a customer until a command names one, and the command episode already covers that case.
- [x] Resolved-ticket summaries (VTID-04412). Every resolve path goes through `notifyFeedbackReporter`, which now also writes two `support_ticket` episodes: one for the member (`active_role NULL`) and one for `role:support`.
  - The text is the ticket's own report and resolution.
  - Episodes are unique per (ticket, role), with importance 45.
  - The member's recall sees their own copy only (golden eval scenario 12).
- [x] The support copy is read (VTID-04431). `support_resolution_search` (service_role only) finds similar resolved tickets in the ticket's tenant and returns ticket ids only. The Sage, Devon and Mira drafters get the published resolution of up to three of them as reference: ticket number, kind and resolution, never another member's report. Drafts are reviewed by a human before a member sees anything. `SUPPORT_PRIOR_RESOLUTIONS_ENABLED=false` turns it off. Not wired: the member-facing support specialist, on purpose; it must only see the member's own tickets.

---

## 7. Decisions for the platform owner — answered 2026-09-23

1. **Delete Cognee and Mem0, no replacement.** Agreed.
2. **Titan V2 (1024-dim) as the single embedder, including re-embedding.** Agreed, and done in Phase 0.
3. **Transcript retention: 90 days.** Raw turns are kept 90 days, then deleted; summaries and facts are kept. This is implemented in Phase 2, when transcripts move out of `memory_items`.
4. **Isolated test database: in AWS.**
   - `scripts/aws/setup-memory-test-db.sh` creates `vitana-memory-test`: private RDS Postgres, synthetic data only, never reachable by the app.
   - It is owner-run, because Claude Code sessions have no `rds:CreateDBInstance`.
   - The golden eval runs against it from an ECS task inside the VPC.
   - For per-PR CI, a throwaway pgvector container in the GitHub runner is the cheaper complement. Phase 0's `write_fact` change was tested the same way, on a local Postgres.
5. **Sequencing:** community first (Phases 0–2), then developers (3), then ERP/support (4).

---

## Appendix — key references

- Gateway memory write: `services/gateway/src/services/inline-fact-extractor.ts`, `extraction-dedup-manager.ts`, `session-memory-commit.ts`, `orb-memory-bridge.ts`
- Gateway memory read: `context-pack-builder.ts`, `memory-broker.ts`, `memory-orchestrator.ts`, `vitana-brain.ts`, `routes/orb-live.ts` (`buildBootstrapContextPack`)
- Embeddings: `embedding-service.ts` (OpenAI/Gemini — dead), `dev-memory-embedding.ts` (Titan v2 — works)
- Dev memory: `dev-agent-memory.ts`, `dev-memory-ranking.ts`, `operator-threads.ts`, `operator-turn-memory.ts`, `autopilot-agent/agent-memory-context.ts`
- Frontend: `vitana-v1/src/hooks/useKnowledgeBase.ts`, `useMemoryMetadata.ts`, `src/pages/Memory.tsx`, `supabase/functions/{ai-chat,extract-diary-insights,generate-memory-embedding,search-memories}`
- Cognee: `services/agents/cognee-extractor/`, `services/gateway/src/services/cognee-extractor-client.ts`, flag `cognee_extraction_enabled` (off since 2026-04-29)
