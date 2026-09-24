# Vitana Platform Database Schema
**CANONICAL REFERENCE - Last Updated: 2025-11-11**

---

## 🔒 CRITICAL RULES

1. **PostgreSQL tables MUST use `snake_case`** (vtid_ledger, oasis_events)
2. **TypeScript code MUST reference EXACT table names from this document**
3. **Before creating ANY new table or query, CHECK THIS FILE FIRST**
4. **When adding a new table, UPDATE THIS FILE in the same commit**

---

## 📊 PRODUCTION TABLES

### vtid_ledger
**Purpose:** Central VTID task tracking system  
**Used by:** 
- `services/gateway/src/routes/vtid.ts` (CRUD operations)
- `services/gateway/src/routes/tasks.ts` (Read-only for Task Board)

**Schema:**
```sql
CREATE TABLE vtid_ledger (
  vtid TEXT PRIMARY KEY,
  layer TEXT NOT NULL,
  module TEXT NOT NULL,
  status TEXT NOT NULL,  -- Values: scheduled, in_progress, completed, pending, active, review, complete, blocked, cancelled
  title TEXT,
  summary TEXT,
  assigned_to TEXT,
  metadata JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
```

**API Endpoints:**
- `POST /api/v1/vtid/create` - Create new VTID
- `GET /api/v1/vtid/:vtid` - Get VTID details
- `PATCH /api/v1/vtid/:vtid` - Update VTID status/metadata
- `GET /api/v1/vtid/list` - List VTIDs with filters
- `GET /api/v1/tasks` - Get tasks for Task Board UI

**Status Values:**
- `scheduled` - Planned work
- `in_progress` - Active work
- `completed` - Finished work
- `pending`, `active`, `review`, `complete`, `blocked`, `cancelled` - Legacy values

---

### oasis_events
**Purpose:** System-wide event log and audit trail  
**Used by:**
- `services/gateway/src/routes/events.ts` (Write via /ingest, Read via /api/v1/events)
- OASIS Operator (via proxy through Gateway)

**Schema:**
```sql
CREATE TABLE oasis_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type TEXT NOT NULL,          -- Event type (e.g., system.heartbeat, connection.established)
  source TEXT NOT NULL,         -- Event source (e.g., oasis-operator, vtid-ledger)
  vtid TEXT,                    -- Associated VTID (optional)
  topic TEXT,                   -- Event topic/category (optional)
  service TEXT,                 -- Service name (optional)
  status TEXT,                  -- Event status (optional)
  message TEXT,                 -- Human-readable message (optional)
  payload JSONB,                -- Event data
  metadata JSONB,               -- Additional metadata
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

**API Endpoints:**
- `GET /api/v1/events` - Query events with filters
- `GET /api/v1/events/stream` - SSE stream of live events
- `POST /api/v1/events/ingest` - Create new event

---

### personalization_audit
**Purpose:** Audit log for cross-domain personalization decisions (VTID-01096)
**Used by:**
- `services/gateway/src/services/personalization-service.ts` (Write audit entries)
- `services/gateway/src/routes/personalization.ts` (Trigger audit writes)

**Schema:**
```sql
CREATE TABLE personalization_audit (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  user_id UUID NOT NULL,
  endpoint TEXT NOT NULL,                  -- API endpoint where personalization was applied
  snapshot JSONB NOT NULL DEFAULT '{}',    -- Non-sensitive summary (no raw diary text)
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

**Important:** The `snapshot` column stores ONLY non-sensitive summaries:
- `snapshot_id` - Reference ID for the personalization snapshot
- `weaknesses` - Array of detected weakness types
- `top_topics` - Array of topic scores (key + score only)
- `recommendation_count` - Number of recommendations generated
- `generated_at` - Timestamp

**API Endpoints:**
- `GET /api/v1/personalization/snapshot` - Generates and logs audit entry

**OASIS Events:**
- `personalization.snapshot.read` - Snapshot generated
- `personalization.applied` - Personalization applied to response
- `personalization.audit.written` - Audit entry recorded

---

### orb_session_state
**Purpose:** Short-lived, TTL'd cross-transport ORB session state, keyed by `(user_id, key)` (DEV-COMHU-0503)
**Used by:**
- `services/gateway/src/services/orb/orb-session-state.ts` (typed read/write/clear helpers)
- `services/gateway/src/routes/orb-live.ts` (`POST /api/v1/orb/session/:id/audio-ready`, continuity, pending CTA)

**Schema:**
```sql
CREATE TABLE orb_session_state (
  user_id      UUID NOT NULL REFERENCES app_users(user_id) ON DELETE CASCADE,
  key          TEXT NOT NULL,           -- see key values below
  value        JSONB NOT NULL,
  expires_at   TIMESTAMPTZ NOT NULL,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, key)
);
```

**Key values:**
| `key` | Written by | Effect when missing |
|---|---|---|
| `audio_ready_ack` | client audio-pipeline-ready handshake (ORB-4) | greeting falls back to a blind 3s timer and can be spoken before the client can play it — the user hears silence |
| `continuity` | close/reopen resume (ORB-2+3) | every session looks "first-time"; no transcript/conversation resume |
| `pending_cta` | autopilot CTA awaiting "yes" (ORB-5) | the confirmation answer has nothing to bind to |
| `recent_openers` | wake-brief opener rotation (VTID-03301) | the same opener repeats every session |

**⚠️ Operational history (VTID-03480):** the original migration
(`20260606000000_DEV_COMHU_0503_orb_session_state.sql`) was authored but
**never applied to production** — its own header said "Not executed from the
sandbox." Because every helper in `orb-session-state.ts` fails soft (reads
return `null`, writes return `ok:false` and never throw), all four features
above were silently dead in production from 2026-06-06 until the migration
was applied on 2026-08-03. The only outward symptom was
`orb.session.audio_ready.acked` carrying `ok:false` on every session.
**When adding a fail-soft table, add a health check that fails loudly —
`ok:false` in a payload nobody alerts on is not detection.**

**OASIS Events:**
- `orb.session.audio_ready.acked` — `payload.ok` is the write result, NOT the client's readiness
- `orb.session.continuity.persisted`

### notification_test_actors
**Purpose:** Accounts whose actions must never notify a real community member (VTID-03506)
**Used by:**
- `_notif_is_test_actor(UUID)` — the predicate; registry match **OR** email pattern
- `trg_suppress_test_actor_notifications` — BEFORE INSERT sink guard on `user_notifications`
- `notify_community_on_public_post()` / `notify_community_on_public_video()` — source-side early return
- Defined in `exafyltd/vitana-v1` migration `20260805160000_vtid_03506_suppress_test_actor_notifications.sql`

**Schema:**
```sql
CREATE TABLE notification_test_actors (
  user_id    UUID PRIMARY KEY,          -- no FK: auth.users is a different schema
  reason     TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- RLS enabled, zero policies: service_role only.
```

**Seeded with:** `a27552a3-0257-4305-8ed0-351a80fd3701` (`e2e-test@vitana.dev`).
The predicate ALSO matches `e2e-%@%` and `%@vitanatest.exafy.io` on
`auth.users.email`, because e2e accounts get minted ad hoc — an unregistered one
created tomorrow would otherwise reach every member.

**⚠️ Why it exists (VTID-03506):** on 2026-08-05 the shared E2E account created 5
public `profile_posts` on **production** while reproducing a feed bug.
`trg_notify_community_post` fans out to the whole tenant, so that became **960
notifications and 600 pushes** to 192 real members in six minutes. Deleting the
posts recalled nothing.

**The guard fails OPEN by design.** Any error resolving the actor (malformed key,
cast failure) returns `NEW` and the notification is delivered — suppressing test
noise is worth strictly less than one real member's notification going missing.

**It is a seatbelt, not a permission slip.** It stops *notifications*; it does not
keep test posts, comments, likes or chat messages out of the real feed. Creating
community content as a test account is forbidden outright — **on every host, not
just prod**: staging and per-PR preview frontends deliberately inherit the
production Supabase project (only the gateway URL is overridden), so they write to
these same tables. See CLAUDE.md rules 31/32.

**Registering a new test account:**
```sql
INSERT INTO notification_test_actors (user_id, reason)
VALUES ('<uuid>', '<who/what this account is>') ON CONFLICT DO NOTHING;
```

---

### service_bot_accounts
**Purpose:** Accounts that are service/automation identities, not real
community members — must never trigger a tenant-wide fan-out addressed to
real users (VTID-03990). Sibling of `notification_test_actors` above, but
gating a different mechanism: that table suppresses *notifications* fired
by a test actor's content; this one stops the *content itself* (a
tenant-wide chat broadcast) from ever being generated on a service
account's behalf in the first place.

**Used by:**
- `fire_welcome_chat_on_membership()` — the VTID-03089 DB trigger on
  `user_tenants` AFTER INSERT — early-return + mark-sent when the new
  primary member is in this table
- `sendWelcomeChatMessages()` (`services/gateway/src/services/welcome-chat-service.ts`)
  — the legacy `/auth/login` first-login path, same trigger condition,
  fails closed (skips) if the lookup itself errors
- Defined in this repo, migration `20260917084341_vtid_03990_service_bot_accounts_skip_welcome_chat.sql`

**Schema:**
```sql
CREATE TABLE service_bot_accounts (
  user_id    UUID PRIMARY KEY,
  label      TEXT NOT NULL,
  reason     TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- RLS enabled, zero policies: service_role only.
```

**⚠️ Why it exists (VTID-03990):** on 2026-09-16 11:38 UTC two automation
identities (`claude-code-agent@exafy.io`, `operator-autopilot@exafy.io`)
were provisioned directly into `user_tenants` as primary members. Neither
matched the single hardcoded Vitana-bot-user check the trigger already had,
so it ran normally and fanned an identical "Hello! My name is ... I just
joined the community" DM out to every other tenant member — **222 and 223
real recipients respectively, within milliseconds of each account's
creation** (445 real chat_messages rows total). Confirmed via a read-only
query against production; nothing was deleted or recalled — a delivered DM
can't be un-sent, same lesson as `notification_test_actors`'s own incident.

**Unlike `notification_test_actors`, this guard fails CLOSED.** A
notification silently dropped costs nothing visible; a tenant-wide chat
broadcast silently sent to 445 real inboxes is the exact incident this
table exists to prevent, so an error resolving the flag skips the
broadcast rather than risking a repeat.

**Registering a new service/automation account:**
```sql
INSERT INTO service_bot_accounts (user_id, label, reason)
VALUES ('<uuid>', '<short identifier>', '<why this is a service account, not a member>')
ON CONFLICT (user_id) DO NOTHING;
```

---

### dev_agent_memory — handoffs + author — APPLIED 2026-09-23 (VTID-04407)
**Purpose:** Phase 3 of `docs/MEMORY-SYSTEM-PLAN.md`. This gives each developer their own
working state next to the repo-wide knowledge.

- `author_user_id uuid` (nullable) is the person a row belongs to. NULL means repo-wide
  knowledge, which is what every row before this change was. Partial index
  `dev_agent_memory_author_recent_idx (author_user_id, category, created_at desc) WHERE superseded_by IS NULL`.
- Category `handoff` was added to the CHECK constraint. It is an end-of-thread note written by
  `POST /api/v1/dev-memory/handoffs/sweep` and read by `GET /api/v1/dev-memory/morning-pack`.
- `write_dev_memory()` was dropped and recreated with a trailing `p_author_user_id uuid default null`.
  Exactly one overload exists. Execute is revoked from `public`/`anon`/`authenticated` and granted
  to `service_role` only.
- `recall_dev_memory()` now leaves out `handoff` rows unless `p_category = 'handoff'`, so stale
  "next steps" never compete with knowledge in semantic recall.

**Status:** migration `20260923190000_vtid_04407_dev_agent_memory_handoff.sql`, applied live
2026-09-23. Checked after applying: one overload, `anon` has no execute, 219 existing rows untouched.

### dev_agent_memory — file-scoped recall + stage provenance — APPLIED 2026-09-21 (VTID-04224)
**Purpose:** extends `dev_agent_memory` (VTID-03889, Operator Console engineering
memory) with two additive columns so the Planner/Worker/Validator LLM
routing stages can eventually read/write it too — previously only the
`memory` extraction stage (Operator Console turns) and the Dev Autopilot
executor's outcome writer touched this table.

- `file_paths text[]` (+ GIN index) — concrete repo-relative files a row
  is about (changed files on write, target files on read); matched by
  plain `&&` array overlap, no glob matching needed since both sides are
  concrete paths.
- `stage text` (`operator`/`planner`/`worker`/`validator`, nullable) —
  provenance only; never restricts which stage may recall a row.

`write_dev_memory()` gained two new trailing defaulted params
(`p_file_paths`, `p_stage`) — every existing caller works unchanged. New
sibling RPC `recall_dev_memory_by_files(p_repo, p_files, p_category?,
p_limit?)` — deterministic recall by file overlap, no embedding call.

**Status:** migration `20260921120000_bootstrap_dev_agent_memory_file_scope.sql`
**applied to the live project 2026-09-21** via the Supabase MCP
(`apply_migration`) — `write_dev_memory()` had to be DROPPED and
RECREATED rather than CREATE-OR-REPLACEd (Postgres treats a different
argument list as a new overload, which briefly left two co-existing
`write_dev_memory` functions and made any unqualified reference to the
name ambiguous — `42725 function name is not unique`). Round-trip
verified live post-apply: `write_dev_memory()` with a placeholder
embedding, `recall_dev_memory_by_files()` found the row by `file_paths`
overlap, then the test row was deleted.

**Used by:** `services/gateway/src/services/dev-agent-memory.ts`
(`recallDevMemoryByFiles`), `operator-turn-memory.ts`'s
`buildExecutionOutcomeMemory` (stamps `stage:'worker'`, threads
`filePaths` through the executor's existing `task_outcome`/`gotcha`
writes).

**Phases 2-4 (same VTID-04224, same PR): read-side wiring into every
autopilot LLM stage.** New `dev-agent-memory-file-recall.ts` —
`buildFileScopedMemoryBlock(files, repo)` (fetch + render in one call,
fails open to `''` on any error) plus three independent, exact-string
`'true'` kill switches, each defaulting OFF (ships inert, same posture as
every other opt-in feature in this file's CHANGE LOG):

- `DEV_AUTOPILOT_WORKER_MEMORY_ENABLED` — both Worker executors (the
  single-shot path's `buildExecutionPrompt` in `dev-autopilot-execute.ts`,
  and the agentic path's `buildAgentTaskPrompt`/`buildFixModeTaskPrompt` in
  `autopilot-agent/run-agent-execution.ts` + `agent-prompt.ts`), recalled
  against the plan's `files_referenced` (or the PR's changed files in fix
  mode).
- `DEV_AUTOPILOT_VALIDATOR_MEMORY_ENABLED` — the pre-merge LLM review
  (`dev-autopilot-llm-review.ts`'s `runLlmMergeReview`/`buildReviewPrompt`),
  recalled against the PR's changed filenames.
- `DEV_AUTOPILOT_PLANNER_MEMORY_ENABLED` — plan generation
  (`dev-autopilot-planning.ts`'s `buildPlanningPrompt`), recalled against
  the finding's `spec_snapshot.file_path` plus, for the feedback-bridge
  lane, `proposed_files`.

Every call site follows the same shape: gate check → `try { await
buildFileScopedMemoryBlock(...) } catch { '' }` → spliced into the
prompt only if non-empty. All four prompt builders are pure/synchronous
and are byte-identical to their pre-Phase-2 output when the block is `''`
or omitted (pinned by tests). **Phase 1's real (non-empty) file-list
wiring into `dev-autopilot-execute.ts`'s two `recordExecutionOutcomeMemory`
call sites remains an explicit follow-up, not done here** — that file's
own change-log history flags it repeatedly as high-churn and
cancellation-sensitive, and Phase 2-4's read side does not depend on it
(the Worker's outcome WRITES still land with `file_paths: []` until that
follow-up ships; the new recall reads are keyed off the PLAN's/PR's own
file list instead, which was always populated).

---

### operator_threads / operator_messages — APPLIED 2026-09-17 (VTID-04022)
**Purpose:** server-side record of the Command Hub Operator Console (W4b of
`docs/OPERATOR-AGENT-BUILD-PLAN.md`, gap analysis §4.3). Until this, the
console's transcript lived only in the browser (`localStorage`, VTID-03822)
and its cross-session memory was the handful of `dev_agent_memory` rows a
few tool outcomes write. One `operator_threads` row per client `threadId`
carrying a rolling `summary` (rewritten every `OPERATOR_THREAD_SUMMARY_EVERY`
turns by the `memory` routing stage); one `operator_messages` row per
user / tool / assistant message. The `oasis_events` audit row per operator
message is unchanged.

**Status:** migration `20260917230000_vtid_04022_operator_threads.sql`
**applied to the live project 2026-09-17 22:20 UTC** via the Supabase MCP
(`apply_migration`), pre-checked (`to_regclass` null for both) and
post-checked (both tables present, RLS enabled, one `service_role` policy
and two indexes each, zero rows) — the repo's Migration Drift Check
(VTID-03486) requires a declared table to exist before the migration can
merge. The gateway code (`services/gateway/src/services/operator-threads.ts`,
behind `OPERATOR_THREADS_ENABLED=true`, default off, not pinned anywhere
yet) is fail-open regardless, so the tables sit empty until the flag is
pinned on staging.

**Used by:**
- `POST /api/v1/operator/chat` (`routes/operator.ts`) — reads the thread
  summary before the model call (`getThreadSummary`), records the turn after
  it (`recordOperatorTurn`, fire-and-forget), summarises on the cadence
  (`maybeSummarizeThread`)
- `processWithGemini()` — `dev_agent_memory` recall runs against
  `buildRecallQuery(summary, message)` instead of the raw message

**Schema:**
```sql
CREATE TABLE operator_threads (
  id              TEXT PRIMARY KEY,          -- the client-supplied threadId
  user_id         UUID,
  tenant_id       UUID,
  role            TEXT,
  title           TEXT,                      -- first line of the first user message
  summary         TEXT,                      -- rolling summary (≤ ~1.6 KB)
  summary_turns   INTEGER NOT NULL DEFAULT 0,-- turn count the summary covers
  turns           INTEGER NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_message_at TIMESTAMPTZ
);
CREATE TABLE operator_messages (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id  TEXT NOT NULL REFERENCES operator_threads(id) ON DELETE CASCADE,
  role       TEXT NOT NULL CHECK (role IN ('user','assistant','tool')),
  content    TEXT NOT NULL,                  -- clipped (6 KB user/assistant, 2 KB tool)
  tool_name  TEXT,
  meta       JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- idx_operator_messages_thread_created (thread_id, created_at DESC)
-- idx_operator_threads_user_updated   (user_id, updated_at DESC)
-- RLS enabled; one FOR ALL policy per table for service_role only —
-- the browser never touches these tables, it talks to /api/v1/operator/*.
```

---

### conversation_metrics_hourly — APPLIED 2026-09-23 (VTID-04371)

Hourly conversation metrics for Command Hub → Conversation → Monitor and
Assistant → Metrics. Migration
`20260923140000_vtid_04371_conversation_metrics_hourly.sql`, applied to the
live project 2026-09-23 (Supabase MCP `apply_migration`, additive), then
backfilled for 168 hours (1.3 s).

```sql
CREATE TABLE conversation_metrics_hourly (
  hour_start   TIMESTAMPTZ      NOT NULL,
  metric       TEXT             NOT NULL,   -- e.g. sessions_started, first_audio_ms_p50
  dimension    TEXT             NOT NULL DEFAULT '',  -- '' = total, else 'lang:de', 'opener:x', 'kind:y', ...
  value        DOUBLE PRECISION NOT NULL,   -- count, sum, average or percentile, per metric
  sample_count INTEGER          NOT NULL DEFAULT 0,   -- rows the value came from; rate = value / sample_count
  computed_at  TIMESTAMPTZ      NOT NULL DEFAULT NOW(),
  PRIMARY KEY (hour_start, metric, dimension)
);
-- idx_conversation_metrics_hourly_metric_hour (metric, hour_start DESC)
```

- Written only by `conversation_metrics_rollup_hour(p_hour)` (SECURITY
  DEFINER, idempotent per hour: delete + insert). `conversation_metrics_backfill(p_hours)`
  re-rolls the last N full hours (cap 720). Both service_role only.
- Sources: `oasis_events` filtered by topic first (`vtid.live.session.start/stop`,
  `voice.latency.measured`, `orb.live.diag`, `orb.live.stall_detected`,
  `conversation.session.finalized`, `conversation.offer.*`) plus `memory_facts.extracted_at`.
- pg_cron job `conversation-metrics-hourly` (`7 * * * *`) re-rolls the previous two hours.
- RLS on, a service_role policy only; `anon`/`authenticated` revoked. Read by
  `GET /api/v1/admin/conversation/metrics/{summary,series,learning}` (exafy_admin).
- VTID-04399 (migration `20260923160000_vtid_04399_metrics_context_setup.sql`,
  applied live 2026-09-23, 168 h re-rolled): the rollup also writes
  `context_setup_empty` (signed-in sessions whose final upstream setup carried
  no context; value = empty, sample_count = measured), `context_setup_source`
  (dimension `source:fresh|snapshot|none|unknown`) and `diag_core_snapshot_used`.

### conversation_scoring_weights — APPLIED 2026-09-23 (VTID-04422)

Versioned weights for the shadow relevance score of continuation candidates
(`candidate-scoring.ts`). Migration
`20260923200000_vtid_04422_conversation_scoring_weights.sql`, applied to the
live project 2026-09-23 (additive), seeded with version 1 (active).

```sql
CREATE TABLE conversation_scoring_weights (
  version         INTEGER     PRIMARY KEY,
  active          BOOLEAN     NOT NULL DEFAULT false,
  weights         JSONB       NOT NULL,   -- urgency, freshness, screen, time_of_day, outcome, profile (>= 0)
  time_of_day_fit JSONB       NOT NULL DEFAULT '{}',  -- kind -> {morning|afternoon|evening|night: 0..1}
  note            TEXT,
  created_by      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

- The gateway reads the highest `active` version (5-minute cache) and falls
  back to identical built-in defaults when unreadable. To change weights, add a
  higher version with `active = true` and deactivate the old row.
- Shadow mode: the score is recorded as `continuation_shadow_ranked` in the
  session's `orb_wake_timelines` row and changes nothing spoken. Read by
  `GET /api/v1/admin/conversation/shadow-ranking` (exafy_admin).
- RLS on, no policies; `anon`/`authenticated` revoked.

### conversation_offer_outcomes — APPLIED 2026-09-23 (VTID-04421)

One row per action Vitana offered (`pending_cta`), settled by its first
outcome. Migration `20260923190000_vtid_04421_conversation_offer_outcomes.sql`,
applied to the live project 2026-09-23 (Supabase MCP `apply_migration`,
additive, table empty at apply).

```sql
CREATE TABLE conversation_offer_outcomes (
  offer_id       UUID        PRIMARY KEY,           -- pending_cta.offer_id
  user_id        UUID        NOT NULL,
  source         TEXT        NOT NULL,              -- offer_action | navigator_* | wake_brief
  provider       TEXT        NOT NULL,              -- producing provider (falls back to source)
  offer_key      TEXT,                              -- the suggestion's dedupe key
  tool           TEXT        NOT NULL,              -- the tool acceptance runs
  offered_at     TIMESTAMPTZ NOT NULL,
  outcome        TEXT        NOT NULL DEFAULT 'made',  -- made | accepted | declined | ignored
  outcome_at     TIMESTAMPTZ,
  outcome_reason TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- idx_conversation_offer_outcomes_user_offered (user_id, offered_at DESC)
-- idx_conversation_offer_outcomes_provider_offered (provider, offered_at DESC)
```

- Written only by the gateway (`offer-outcomes.ts`, the default offer-event
  emitter): `made` inserts (idempotent on `offer_id`), the first
  accepted/declined/ignored settles the row (`WHERE outcome = 'made'`).
- `conversation_offer_outcome_stats(p_since, p_ignored_after = 1 day, p_user_id)`
  returns per-provider made/accepted/declined/ignored/open; an offer still
  `made` after `p_ignored_after` counts as ignored. service_role only.
- RLS on, no policies; `anon`/`authenticated` revoked. Read by
  `GET /api/v1/admin/conversation/offer-outcomes` (exafy_admin).

#### user_assistant_state signal `brain_core_snapshot_v1` (VTID-04399)

No schema change — a new `signal_name` on the existing table, one row per
(tenant, user), upserted on `tenant_id,user_id,signal_name`. `value` =
`{version: 1, role: 'community', lang, built_at, chars, hash, source:
'session_build'|'finalize_refresh', instruction}` where `instruction` is the
stable part of the ORB brain instruction (≤ 32 000 chars). Written by the
gateway after a fresh session build (throttled) and ~90 s after a session
ends; read at session start as the fallback when the fresh build misses the
stream-open gate. Kill switch `BRAIN_CORE_SNAPSHOT=false`.

### agent_runs / agent_run_steps / agent_run_signals / agent_runs_unified — APPLIED 2026-09-23 (VTID-04319)

Orchestrator v2 run ledger (`docs/ORCHESTRATOR-REDESIGN-PLAN.md` §3.3). Migration
`20260923120000_vtid_04319_orchestrator_run_ledger.sql`, applied to the live
project 2026-09-23 (Supabase MCP `apply_migration`, additive, pre/post-checked).

- `agent_runs` — native run ledger (id, parent/root run, agent_id, plane,
  principal jsonb, user_id, tenant_id, vtid, intent, status
  `queued|running|waiting_signal|awaiting_approval|succeeded|failed|cancelled`,
  tier `read|draft|commit|high`, idempotency_key UNIQUE, budget/spent USD,
  lease_owner/lease_until, created_via, deliver_to, result_ref, error, metadata,
  timestamps). **Empty until a plane writes natively (P4).**
- `agent_run_steps` — append-only progress ledger per run (seq UNIQUE per run;
  kind `model_call|tool_call|observation|progress|note`; progress/looping flags;
  tokens, cost, duration).
- `agent_run_signals` — approval / rejection / ci_result / cancel / user_reply / timeout.
- `agent_runs_unified` — read-only VIEW (`security_invoker = true`) projecting
  `dev_autopilot_executions`, `automation_runs`, `self_healing_log` and native
  `agent_runs` into one shape (`run_key`, `plane`, `agent_id`, generic `status`,
  `source_status`, `vtid`, `tenant_id`, `parent_run_key`, `created_via`, `title`,
  `error`, `result_ref`, timestamps). Read by `GET /api/v1/orchestrator/runs`.

All four: RLS on (tables), no policies, `anon`/`authenticated` revoked — service role only.

**Run leases (VTID-04446) — migration committed, NOT APPLIED.**
`20260923210000_vtid_04446_run_leases.sql` adds a partial index
`idx_agent_runs_running_lease` on `agent_runs (lease_until) WHERE status = 'running'`
and re-creates `agent_runs_unified` with one change: native rows carrying
`metadata.mirror_of` (the lease row of a Dev Autopilot execution,
`idempotency_key = dev_autopilot:<execution id>`) are excluded, since the
execution already appears through its own projection. No table is created or
altered. Apply it before setting `ORCHESTRATOR_RUN_LEASE_ENABLED=true`.

`agents_registry` gained agent-card columns in the same migration: `skills`,
`domains`, `roles_allowed`, `surfaces_allowed` (text[], default `{}`),
`llm_stage`, `max_tier` (CHECK read|draft|commit|high), `budget_per_run_usd`,
`budget_per_day_usd`, `owner`, `eval_suite`, `eval_pass_rate`, `enabled`
(default true). Seeded: conductor / crewai-gcp / validator-core `enabled=false`
(source removed, VTID-04318); stage/tier on six known agents; five
previously unregistered agents inserted.

### connected_app_settings / apple_account_credentials — Connected Apps hub — APPLIED 2026-09-23 (VTID-04402..04405)
**Purpose:** one on/off switch per Mail / Calendar / Contacts app on the
Connected Apps screen (Gmail, Google Calendar, Google Contacts, Outlook Mail,
Outlook Calendar, Outlook Contacts, Apple Mail, Apple Calendar, iPhone Contacts,
Android Contacts). Migrations:
`supabase/migrations/20260923200000_vtid_04402_connected_apps.sql`, and
`20260924100000_vtid_04449_outlook_contacts_app.sql`, which adds `outlook-contacts`
to the app id CHECK (imported rows use `contacts.source = 'microsoft'`).

```sql
CREATE TABLE connected_app_settings (
  user_id      UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  app_id       TEXT NOT NULL,          -- one of the ten app ids (CHECK)
  enabled      BOOLEAN NOT NULL DEFAULT false,
  last_sync_at TIMESTAMPTZ,
  last_result  JSONB,                  -- e.g. {"imported":120} or {"busy":14}
  last_error   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, app_id)
);

CREATE TABLE apple_account_credentials (
  user_id           UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  tenant_id         UUID,
  apple_id          TEXT NOT NULL,
  secret_ciphertext BYTEA NOT NULL,    -- AES-256-GCM (AI_CREDENTIALS_ENC_KEY)
  secret_iv         BYTEA NOT NULL,
  secret_tag        BYTEA NOT NULL,
  caldav_home_url   TEXT,
  carddav_home_url  TEXT,
  verified_at       TIMESTAMPTZ,
  last_error        TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Both: RLS enabled, zero policies, REVOKE ALL from anon/authenticated → service role only.
```

**Also changed by the same migration:**
- `social_connections.provider` CHECK also allows `'microsoft'` (Outlook Mail + Calendar share one Graph token).
- `social_connections.scopes` now stores the scopes the provider actually **granted** (was: the configured list).
- `contacts.source` / `contacts.external_id` + unique index `(user_id, source, external_id)` — imported contacts de-duplicate per source (`google`, `icloud`, `android`); hand-added contacts keep both NULL.
- `calendar_external_busy.source` CHECK allows `'google','microsoft','apple'` — Outlook and iCloud busy times show as grey blocks too. Times only, never titles.

**Rules:** tokens stay in `social_connections` (Google, Microsoft) or here encrypted (Apple). Turning an app off deletes what it left in Vitanaland (busy rows; imported contacts only when the member ticks it); turning the provider's last app off releases the grant (Google refresh token revoked, Microsoft tokens dropped, Apple credentials deleted).

### calendar_push_targets / calendar_push_links — Outlook + iCloud calendar push — APPLIED 2026-09-24 (VTID-04436)
**Purpose:** the Outlook Calendar and Apple Calendar (iCloud) apps write the
member's own community / personal entries into one calendar named
"Vitanaland" in the member's account, the way VTID-04372 does for Google.
Migration: `supabase/migrations/20260924090000_vtid_04436_calendar_push.sql`.

```sql
CREATE TABLE calendar_push_targets (
  user_id            UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  provider           TEXT NOT NULL CHECK (provider IN ('microsoft','apple')),
  remote_calendar_id TEXT,             -- Graph calendar id / CalDAV collection URL; NULL = recreate
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, provider)
);

CREATE TABLE calendar_push_links (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  provider          TEXT NOT NULL CHECK (provider IN ('microsoft','apple')),
  calendar_event_id UUID REFERENCES calendar_events(id) ON DELETE SET NULL,
  remote_id         TEXT NOT NULL,     -- Graph event id / .ics resource URL
  pushed_hash       TEXT NOT NULL,     -- SHA-256 of what was sent; unchanged → no write
  pushed_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider, calendar_event_id)
);
-- Both: RLS enabled, zero policies, REVOKE ALL from PUBLIC/anon/authenticated → service role only.
```

**Rules:** only the Vitanaland calendar is ever written. Turning the app off
deletes these rows; the Vitanaland calendar stays in the member's account.
The busy pull skips that calendar, so pushed entries never come back as grey
blocks. Kill switch: `CONNECTED_APPS_CALENDAR_PUSH=false`.

---

### Wallet System (USD / Credits / VTNA) — added 2026-07-17

**This is the live, production system backing the wallet UI** (`useWallet.ts`
in `vitana-v1` → `user_wallets` + RPCs below). It predates and is entirely
separate from the newer EUR/USD Stripe deposit tables (`wallet_accounts`,
`wallet_deposits`, `wallet_ledger_entries`) added for real fiat deposits —
those exist but currently hold no data and are not yet wired into the
existing wallet UI.

**Known dead code:** the `wallet_transactions`/`wallet_balances` "Credits
ledger" described in earlier automations-engine migrations
(`20260318000000_vtid_01250_autopilot_automations_engine.sql`) never
actually took effect — `CREATE TABLE IF NOT EXISTS wallet_transactions`
silently no-op'd because a table of that name already existed (below) with
a completely different, incompatible column set, which means that
migration's later statements referencing `tenant_id`/`type` columns broke
and `wallet_balances` was never created. `credit_wallet_for_earning()` /
`debit_wallet_for_spend()` / `update_wallet_balance()` exist as functions
but will error if called (`wallet_balances` doesn't exist). Do not build on
this path without fixing or removing it first.

```sql
CREATE TABLE public.user_wallets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  currency_type TEXT NOT NULL,      -- 'USD' | 'VTNA' | 'CREDITS'
  balance NUMERIC(15,2) NOT NULL DEFAULT 0.00,   -- was 1000.00 until VTID wallet-reset
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, currency_type)
);

CREATE TABLE public.wallet_transactions (   -- old (2025-09) schema; still the live one
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  from_user_id UUID, to_user_id UUID,       -- reference auth.users.id, NOT profiles.id
  transaction_type TEXT NOT NULL,   -- 'transfer' | 'exchange' | 'reward' | 'purchase'
  from_currency TEXT, to_currency TEXT,
  amount NUMERIC(15,2) NOT NULL,
  exchange_rate NUMERIC(10,4),
  fees NUMERIC(15,2) DEFAULT 0.00,
  status TEXT DEFAULT 'pending',
  metadata JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
-- from_user_id/to_user_id → profiles.user_id via wallet_transactions_from_user_id_fkey
-- / _to_user_id_fkey (added 2026-07-21, NOT VALID — see change log). profiles.id is a
-- separate surrogate PK; profiles.user_id is the actual auth.users.id link (UNIQUE).

CREATE TABLE public.exchange_rates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  from_currency TEXT NOT NULL, to_currency TEXT NOT NULL,
  rate NUMERIC(10,6) NOT NULL,
  trend TEXT, change_24h NUMERIC(5,2) DEFAULT 0.00,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  is_active BOOLEAN DEFAULT true    -- current canonical rate: only is_active=true rows count
);

CREATE TABLE public.wallet_balance_resets (   -- added VTID wallet-reset, 2026-07-17
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  source_table TEXT NOT NULL,       -- 'user_wallets' | 'wallet_accounts'
  currency_type TEXT NOT NULL,
  previous_balance NUMERIC NOT NULL,
  reset_at TIMESTAMPTZ DEFAULT NOW(),
  reason TEXT NOT NULL
);
```

**Canonical exchange rate** (the only `is_active=true` rows in
`exchange_rates`, matching `vitana-v1`'s `src/lib/exchangeRates.ts`):
**1 USD = 100 CREDITS = 100 VTNA**, VTNA:CREDITS at 1:1 parity.

**RPCs** (`get_user_balance`, `update_user_balance`, `initialize_user_wallet`,
`process_wallet_exchange`, `process_wallet_transfer`,
`process_wallet_exchange_and_send`) are `SECURITY DEFINER` and
`GRANT EXECUTE`'d to `authenticated`. **Security fix (2026-07-17,
`20260717120000_harden_wallet_rpc_ownership_and_rate_lookup.sql`):** none of
them previously checked that the caller (`auth.uid()`) owned the
`user_id`/`from_user_id` parameter being debited/credited — any authenticated
user could fabricate balance for themselves or drain another user's wallet by
calling the RPC directly. All four now raise if `auth.uid()` is set and
doesn't match the account being debited (`auth.uid() IS NULL` — i.e.
service-role/backend calls — still passes through). `process_wallet_exchange`
and `process_wallet_exchange_and_send` also no longer trust a client-supplied
exchange rate; they look it up from `exchange_rates` (`is_active=true`)
server-side.

**Real-world-launch reset (2026-07-17,
`20260717120100_reset_all_user_wallet_balances_to_zero.sql`):** every
existing user's `user_wallets.balance` (209 users × USD/CREDITS/VTNA) was
zeroed; pre-reset values were archived into `wallet_balance_resets` first.
`initialize_user_wallet()`/`get_user_balance()` and the `user_wallets.balance`
column default were changed from seeding/falling back to `1000.00` to `0.00`,
so new signups start at zero. `wallet_accounts` (EUR/USD Stripe wallet) had
no non-zero rows to reset (185 users, all already 0 — no real deposits made
yet).

**Deposit bridge (2026-07-20,
`20260720090000_bridge_credit_deposit_into_legacy_user_wallets.sql`):** the
real Stripe deposit flow (`wallet.ts` → `deposit-service.ts` → webhook →
`credit_deposit`) credited `wallet_accounts`, a table the wallet UI never
reads. `credit_deposit` now also mirrors USD deposits into `user_wallets`,
atomically, in the same row-locked transaction as the `wallet_accounts`
credit. Also fixed `createDeposit`'s Stripe `success_url`/`cancel_url`,
which pointed at `/wallet/deposit/success` and `/wallet/deposit/canceled` —
routes that never existed in the `vitana-v1` SPA — to redirect to the
existing `/wallet` route with query params instead. Paired with a
`vitana-v1` change wiring `AddFundsPopup` to this real flow in place of a
direct fake balance write.

**Atomicity + transaction logging (2026-07-20,
`20260720190000_fix_wallet_rpc_atomicity_and_transaction_logging.sql`):**
`update_user_balance`, `process_wallet_exchange`, `process_wallet_transfer`,
and `process_wallet_exchange_and_send` all had the same TOCTOU race —
`SELECT balance`, check sufficiency in application code, `THEN UPDATE` — a
double-tap or retried request could double-spend. Rewritten as a single
atomic `UPDATE ... WHERE balance >= amount RETURNING balance` in all four.
`update_user_balance` also gained optional `p_transaction_type`/
`p_description` params so it can log to `wallet_transactions` like the
other three already did (it previously never did, so Withdraw/Stake/Spend
left zero history). CHECK constraint extended with `'withdrawal'`/`'stake'`
to cover those two actions. Note: adding the two new trailing params to
`update_user_balance` via `CREATE OR REPLACE` created a second overload
instead of replacing the original (Postgres allows same-name functions with
different signatures to coexist); the migration explicitly `DROP`s the
stale 4-arg overload afterward so only the atomic, logging-capable version
can be called.

**VTNA/Credits merge (2026-07-20, BOOTSTRAP-VTNA-CREDITS-MERGE,
`20260720200000_fold_vtna_balance_into_credits.sql`):** VTNA (marketed in the
UI as a stakeable, appreciating "token" with governance voting and passive
staking-APY rewards) and CREDITS already had fixed 1:1 parity and identical
closed-loop/non-withdrawable semantics — VTNA's investment-flavored framing
had already caused an Apple App Store rejection under guideline 3.1.5(iii)
(looked like a crypto exchange); the existing workaround only hid the
stake/exchange/withdraw UI on iOS, leaving it live on web/Android. Merged
the two into a single user-facing currency, "VTNA Credits" (`vitana-v1`):
removed the dedicated Buy-VTNA-Tokens and Stake-VTNA-Tokens popups and all
staking-APY/governance/appreciation copy; removed VTNA as a selectable
currency from every send/request/exchange/booking-payment picker; the
separate VTNA balance card/tile is gone, folded into one "VTNA Credits"
balance. **No `currency_type` schema change** — `CREDITS` remains the
canonical DB value (relabeled "VTNA Credits" only in UI copy); `VTNA` stays
a valid historical value on existing `wallet_transactions` rows and in the
`currency_type`/`ExchangeRate` TypeScript unions for backward-compat
display, it is simply never written by any live code path going forward.
This migration defensively folds any nonzero `user_wallets` VTNA balance
into CREDITS before the frontend permanently stops writing to VTNA;
verified no-op at authoring time (all 212 users had VTNA balance = 0.00,
consistent with the 2026-07-17 reset). `exchange_rates`' VTNA-related rows
are left in place (harmless, unread) rather than deleted, since nothing
queries them anymore.

Also fixed in the same PR (found during this work, unrelated to the
merge): `WalletMasterActionPopup.tsx`'s "quick actions" menu called
`updateBalance()` directly with hardcoded amounts and no real payment or
withdrawal behind them — tapping "Buy Credits"/"Buy Tokens"/"Claim Rewards"
fabricated free balance, and "Withdraw & Cash Out" silently destroyed real
USD balance with a fake "submitted for processing" toast and no actual
withdrawal. Removed; the real, working equivalents (Stripe-backed
`BuyCreditsPopup`, transaction-logged `WithdrawPopup`) are wired directly on
the Wallet balance cards and unaffected.

**Not in scope for this pass (flagged, not fixed):** a handful of "wallet
intelligence" dashboard widgets (staking-optimization/APY/governance/
tokenomics cards on `pages/wallet/Balance.tsx`'s Tokens tab and elsewhere)
still show fabricated mock data with similar investment-flavored framing;
this pass only removed the copy/mock-data directly tied to the two deleted
VTNA popups and two intelligence-card snippets that explicitly referenced
"VTNA conversion rates." A full sweep of fabricated wallet dashboard
widgets is separate, larger, not-yet-approved work.

**Missing `wallet_transactions` FK constraints (2026-07-21,
`20260721180000_add_wallet_transactions_profile_fkeys.sql`):** found while
verifying the VTNA/Credits merge deploy on AWS staging — the Wallet's
"Recent Activity" transaction list has never actually worked. `useWallet.ts`'s
`fetchTransactions` embeds sender/recipient profile info via named
PostgREST hints (`profiles!wallet_transactions_from_user_id_fkey` /
`_to_user_id_fkey`), but `wallet_transactions.from_user_id`/`to_user_id` had
**zero** foreign key constraints at all — every call 400'd with "Could not
find a relationship." Pre-existing bug, unrelated to the merge itself.
Added both named FK constraints, targeting `profiles.user_id` (the actual
`auth.users.id` link — `profiles.id` is a separate surrogate PK). Added
`NOT VALID` since 7-11 of 85 existing rows have a user_id with no matching
profile (stale test/reset-era data); PostgREST recognizes `NOT VALID` FKs
for relationship embedding immediately, and the constraint still fully
enforces on every new INSERT/UPDATE going forward — only the historical
rows are exempted from the initial validation scan. Verified end-to-end via
a direct PostgREST request against the live project: `200 OK` with real
`from_profile`/`to_profile` data resolved.

---

## ⚠️ DEPRECATED / DO NOT USE

### VtidLedger (PascalCase)
**Status:** ❌ DO NOT USE - Empty table, deprecated  
**Reason:** Naming convention mismatch. Use `vtid_ledger` instead.

---

### services_catalog
**Purpose:** Catalog of services available to users (coaches, doctors, labs, etc.)
**Used by:** `services/gateway/src/routes/offers.ts` (CRUD operations)

**Schema:**
```sql
CREATE TABLE services_catalog (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  name TEXT NOT NULL,
  service_type TEXT NOT NULL,  -- Values: coach, doctor, lab, wellness, nutrition, fitness, therapy, other
  topic_keys TEXT[] NOT NULL DEFAULT '{}',
  provider_name TEXT NULL,
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

**API Endpoints:**
- `POST /api/v1/catalog/services` - Add service to catalog

---

### products_catalog
**Purpose:** Catalog of products available to users (supplements, devices, apps, etc.)
**Used by:** `services/gateway/src/routes/offers.ts` (CRUD operations)

**Schema:**
```sql
CREATE TABLE products_catalog (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  name TEXT NOT NULL,
  product_type TEXT NOT NULL,  -- Values: supplement, device, food, wearable, app, other
  topic_keys TEXT[] NOT NULL DEFAULT '{}',
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

**API Endpoints:**
- `POST /api/v1/catalog/products` - Add product to catalog

---

### user_offers_memory
**Purpose:** Tracks user relationship to services/products (viewed, saved, used, dismissed, rated)
**Used by:** `services/gateway/src/routes/offers.ts` (CRUD operations)

**Schema:**
```sql
CREATE TABLE user_offers_memory (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  user_id UUID NOT NULL,
  target_type TEXT NOT NULL,  -- Values: service, product
  target_id UUID NOT NULL,
  state TEXT NOT NULL,  -- Values: viewed, saved, used, dismissed, rated
  trust_score INT NULL,  -- 0-100
  notes TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, user_id, target_type, target_id)
);
```

**API Endpoints:**
- `POST /api/v1/offers/state` - Set user state for service/product
- `GET /api/v1/offers/memory` - Get user offers memory

---

### usage_outcomes
**Purpose:** User-stated outcomes from using services/products (deterministic, non-medical)
**Used by:** `services/gateway/src/routes/offers.ts` (CRUD operations)

**Schema:**
```sql
CREATE TABLE usage_outcomes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  user_id UUID NOT NULL,
  target_type TEXT NOT NULL,  -- Values: service, product
  target_id UUID NOT NULL,
  outcome_date DATE NOT NULL,
  outcome_type TEXT NOT NULL,  -- Values: sleep, stress, movement, nutrition, social, energy, other
  perceived_impact TEXT NOT NULL,  -- Values: better, same, worse
  evidence JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

**API Endpoints:**
- `POST /api/v1/offers/outcome` - Record usage outcome

---

### relationship_edges
**Purpose:** Graph edges representing user relationships to entities (services, products, people)
**Used by:** `services/gateway/src/routes/offers.ts` (relationship graph)

**Schema:**
```sql
CREATE TABLE relationship_edges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  user_id UUID NOT NULL,
  target_type TEXT NOT NULL,  -- Values: service, product, person, community
  target_id UUID NOT NULL,
  relationship_type TEXT NOT NULL,  -- Values: using, trusted, saved, dismissed, connected, following
  strength INT NOT NULL DEFAULT 0,  -- -100 to 100
  context JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, user_id, target_type, target_id)
);
```

**API Endpoints:**
- `GET /api/v1/offers/recommendations` - Get recommendations (uses relationship strength)

---

### d44_predictive_signals
**Purpose:** Proactive early intervention signals (VTID-01138 D44)
**Used by:**
- `services/gateway/src/services/d44-signal-detection-engine.ts` (Detection logic)
- `services/gateway/src/routes/signal-detection.ts` (API endpoints)

**Schema:**
```sql
CREATE TABLE d44_predictive_signals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  user_id UUID NOT NULL,
  signal_type TEXT NOT NULL,  -- Values: health_drift, behavioral_drift, routine_instability, cognitive_load_increase, social_withdrawal, social_overload, preference_shift, positive_momentum
  confidence INTEGER NOT NULL CHECK (confidence >= 0 AND confidence <= 100),
  time_window TEXT NOT NULL,  -- Values: last_7_days, last_14_days, last_30_days
  detected_change TEXT NOT NULL,
  user_impact TEXT NOT NULL,  -- Values: low, medium, high
  suggested_action TEXT NOT NULL,  -- Values: awareness, reflection, check_in
  explainability_text TEXT NOT NULL,
  evidence_count INTEGER NOT NULL DEFAULT 0,
  detection_source TEXT NOT NULL DEFAULT 'engine',  -- Values: engine, manual, scheduled
  domains_analyzed TEXT[] NOT NULL DEFAULT '{}',
  data_points_analyzed INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',  -- Values: active, acknowledged, dismissed, actioned, expired
  acknowledged_at TIMESTAMPTZ,
  actioned_at TIMESTAMPTZ,
  user_feedback TEXT,
  linked_drift_event_id UUID,
  linked_memory_refs TEXT[] DEFAULT '{}',
  linked_health_refs TEXT[] DEFAULT '{}',
  linked_context_refs TEXT[] DEFAULT '{}',
  detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

**API Endpoints:**
- `GET /api/v1/predictive-signals` - List active signals
- `GET /api/v1/predictive-signals/:id` - Get signal details
- `POST /api/v1/predictive-signals/:id/acknowledge` - Acknowledge signal
- `POST /api/v1/predictive-signals/:id/dismiss` - Dismiss signal
- `GET /api/v1/predictive-signals/stats` - Get signal statistics

**OASIS Events:**
- `d44.signal.detected` - New signal detected
- `d44.signal.acknowledged` - Signal acknowledged by user
- `d44.signal.dismissed` - Signal dismissed by user
- `d44.signal.expired` - Signal expired

---

### d44_signal_evidence
**Purpose:** Evidence references linked to predictive signals (VTID-01138 D44)
**Used by:**
- `services/gateway/src/services/d44-signal-detection-engine.ts`
- `services/gateway/src/routes/signal-detection.ts`

**Schema:**
```sql
CREATE TABLE d44_signal_evidence (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  user_id UUID NOT NULL,
  signal_id UUID NOT NULL REFERENCES d44_predictive_signals(id) ON DELETE CASCADE,
  evidence_type TEXT NOT NULL,  -- Values: memory, health, context, diary, calendar, social, location, wearable, preference, behavior
  source_ref TEXT NOT NULL,
  source_table TEXT NOT NULL,
  weight INTEGER NOT NULL DEFAULT 50 CHECK (weight >= 0 AND weight <= 100),
  summary TEXT NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

---

### d44_intervention_history
**Purpose:** History of user actions on predictive signals (VTID-01138 D44)
**Used by:**
- `services/gateway/src/services/d44-signal-detection-engine.ts`
- `services/gateway/src/routes/signal-detection.ts`

**Schema:**
```sql
CREATE TABLE d44_intervention_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  user_id UUID NOT NULL,
  signal_id UUID NOT NULL REFERENCES d44_predictive_signals(id) ON DELETE CASCADE,
  action_type TEXT NOT NULL,  -- Values: acknowledged, dismissed, marked_helpful, marked_not_helpful, took_action, reminder_set, shared
  action_details JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

---

## 🎯 ADDING A NEW TABLE

When adding a new table, follow this checklist:

1. ✅ Use `snake_case` naming
2. ✅ Add table definition to this document
3. ✅ Document which services use it
4. ✅ List all API endpoints
5. ✅ Include schema with data types
6. ✅ Commit schema doc with table creation

**Example:**
```markdown
### my_new_table
**Purpose:** What this table does
**Used by:** services/path/to/file.ts

**Schema:**
CREATE TABLE my_new_table (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

**API Endpoints:**
- GET /api/v1/my-resource
```

---

## 🔍 TROUBLESHOOTING

**Problem:** "Could not find table in schema cache"  
**Solution:** Check table name matches EXACTLY (case-sensitive, underscores)

**Problem:** Updates not appearing in UI  
**Solution:** Verify write and read operations use SAME table name

**Problem:** Duplicate tables with different names  
**Solution:** Check this document, use canonical name, deprecate duplicate

---

## 📝 CHANGE LOG

| Date | Change | Author | VTID |
|------|--------|--------|------|
| 2026-09-24 | VTID-04460, **applied live** (additive, expand step): `user_intents.embedding_v2 vector(1024)` and `vtid_ledger.embedding_v2 vector(1024)` (Titan V2), partial index `user_intents_embedding_v2_pending_idx` (created_at WHERE embedding_v2 IS NULL); functions `compute_intent_matches_v2`, `search_intent_catalog_v2` (authenticated + service_role) and `find_similar_vtid_tasks_v2` (service_role) — copies of the live functions reading `embedding_v2`, catalog query cast `vector(1024)` (the old one cast to `vector(768)` and silently dropped every 1536-dim query). Old `embedding` columns and functions stay for the previous gateway; contract (drop them, switch `compute_intent_matches_daily` / `intent_matches_recompute_daily` to `_v2`) after prod runs the new code. | Claude Code | VTID-04460 |
| 2026-09-23 | VTID-04446, **committed, NOT applied** (owner applies): migration `20260923210000_vtid_04446_run_leases.sql` — partial index `idx_agent_runs_running_lease` + `agent_runs_unified` re-created excluding lease mirrors (`metadata.mirror_of`). Additive; required before `ORCHESTRATOR_RUN_LEASE_ENABLED=true`. | Claude | VTID-04446 |
| 2026-09-23 | VTID-04411/04412, **applied live**: `memory_categories` `customer` (→ business_projects) and `support_ticket` (→ uncategorized); indexes `idx_memory_items_customer_key` (tenant, content_json->>customer_key, occurred_at desc) WHERE category_key='customer', unique `uq_memory_items_customer_command` (content_json->>command_id) and unique `uq_memory_items_support_ticket` (content_json->>ticket_id, coalesce(active_role,'')). | Claude Code | VTID-04411 |
| 2026-09-23 | VTID-04431, **applied live**: function `support_resolution_search(p_query_embedding vector, p_tenant_id uuid, p_top_k int default 3, p_exclude_ticket_id text, p_min_similarity float8 default 0.35)` — read-only, `service_role` only; searches `memory_items` `support_ticket` rows with `active_role='support'` in ONE tenant and returns `(ticket_id, similarity, occurred_at)` only, never episode text. Used by the Sage/Devon/Mira drafters. | Claude Code | VTID-04431 |
| 2026-09-23 | VTID-04441, **applied live**: table `memory_fact_forgotten (id, tenant_id, user_id, fact_key, value_hash, forgotten_at)`, unique on (tenant_id, user_id, fact_key, value_hash), RLS on, `service_role` only. One row per value a user forgot in the Memory Garden; `value_hash` is sha256 of the normalised value, the value is not kept. `rememberFact()` refuses an inferred write of a forgotten value; an explicit user statement clears the marker. | Claude Code | VTID-04441 |
| 2026-09-23 | VTID-04407, **applied live**: `dev_agent_memory.author_user_id` + category `handoff` + `write_dev_memory(..., p_author_user_id)` (single overload, service_role only) + `recall_dev_memory()` excludes handoffs. | Claude Code | VTID-04407 |
| 2026-09-24 | Onboarding engine storage (VTID-04478, spec §6.1/§6.2): `partner_onboarding_steps` (per-org status of the steps a dedicated endpoint decides) and `partner_terms_acceptances` (audit of a terms acceptance: version, user, time, IP, user agent). RLS on, member SELECT via `is_partner_org_member()`, writes revoked from anon/authenticated. Migration `20260924150000_vtid_04478_partner_onboarding_engine.sql`. **Applied to the live project 2026-09-24** on the platform owner's go-ahead, before merge (Migration Drift Check). Post-checked: both tables with RLS and the member SELECT policy. Browser roles keep only SELECT/REFERENCES/TRIGGER; INSERT/UPDATE/DELETE/TRUNCATE are revoked. TRUNCATE was added to the revoke during the apply, because Supabase's default grants include it and RLS does not cover it. | Claude | VTID-04478 |
| 2026-09-24 | Partner account model (VTID-04471, spec §5.1/§5.2): `partner_organizations` gains `partner_type`, `lifecycle_state`, `legal_name`, `country`, `vat_id`, `website`, `trust_level`, the helpers `partner_org_status_for_lifecycle()` / `partner_org_vertical_for_type()` and `trg_partner_organizations_sync`; `merchants.partner_organization_id` and `partner_tenant.partner_organization_id` FKs with an idempotent backfill. Migrations `20260924130000_vtid_04471_partner_account_model.sql` + Prisma `20260924_vcaop_partner_org_link_0007`. **Applied to the live project 2026-09-24** on the platform owner's go-ahead, before the gateway change merged (`/register` and `/mine` select the new columns). Post-checked read-only: all 9 columns, 4 CHECKs, both FKs, the 3 functions and the trigger present, and the mappings correct. The backfill changed no rows (0 orgs, 0 owned merchants, 0 `partner_tenant` rows before and after). | Claude | VTID-04471 |
| 2026-09-23 | VTID-04391, **applied live**: `memory_categories` row `daily_learning` (mapped to `uncategorized`) and partial unique index `uq_memory_items_daily_learning` on `memory_items (user_id, (content_json->>'date')) WHERE category_key = 'daily_learning'` — one daily learning per user per local date, written by AP-0914. | Claude Code | VTID-04391 |
| 2026-09-23 | Memory Phase 2, **applied to the live project 2026-09-23**: new table `memory_transcript_turns` (raw conversation turns, RLS own-rows SELECT, service-role writes) with `purge_memory_transcript_turns(p_days >= 30)` scheduled daily by pg_cron `purge-memory-transcript-turns` (90 days); the last 90 days of raw turns in `memory_items` copied into it. `memory_categories` gains the 13 Garden category keys, and `memory_category_mapping` gains `personal → personal_identity`. `ai_memory` (112 active) and `diary_entries` (273) copied into `memory_items` as episodes (`content_json.kind = legacy_ai_memory / diary`, linked by id, importance ≤ 50 so `trg_notify_memory_garden` did not fire — 0 notifications). Legacy tables untouched. | Claude Code | VTID-04387 / VTID-04388 / VTID-04389 / VTID-04390 |
| 2026-09-23 | Memory Phase 1 (docs/MEMORY-SYSTEM-PLAN.md), **applied to the live project 2026-09-23**: `memory_categories` row `session_summary` (mapped to Garden `uncategorized`) and partial unique index `uq_memory_items_session_summary` on `memory_items (user_id, (content_json->>'session_id')) WHERE category_key = 'session_summary'` — at most one session-summary episode per session. No DDL for role scope: `memory_items.active_role` (existing column, 3,183 rows all NULL) is now written — NULL for personal roles, the role otherwise — and read through the existing `p_active_role` parameter of `memory_semantic_search`. The gateway no longer writes or reads the tier-2 mirrors `mem_facts` / `mem_episodes`. | Claude Code | VTID-04364 / VTID-04365 / VTID-04366 / VTID-04367 |
| 2026-09-23 | Memory Phase 0 (docs/MEMORY-SYSTEM-PLAN.md), all **applied to the live project 2026-09-23**: `write_fact()` no longer re-inserts a fact whose value did not change unless the source is stronger (new helper `_memory_provenance_rank`) — 80% of `memory_facts` rows were same-value `preferred_language` rewrites; `memory_items.embedding` and `memory_facts.embedding` changed to `vector(1024)` (Amazon Titan Text Embeddings V2, the single memory embedder), old OpenAI/Gemini vectors nulled for re-embedding, HNSW indexes rebuilt; new service-role RPC `ci_memory_health()` for the morning health check. See the Memory section below. | Claude Code | VTID-04341 / VTID-04342 / VTID-04345 |
| 2026-09-18 | `lab_reports` RLS replaced by the user-scoped `lab_reports_user_policy` (`user_id = auth.uid()`, FOR ALL) and `trg_notify_lab_report` moved from AFTER INSERT to AFTER UPDATE OF `processing_status` → `parsed`. The c1 tenant-gated policies depended on `current_tenant_id()`, which is NULL for browser JWTs, so the health-report upload had never inserted a single row (22 orphaned `health-reports` objects from 4 real users, 0 rows, RLS violations in the Postgres logs for the latest two attempts 2026-09-17 14:45 UTC). Migration `20260918100000_vtid_04044_lab_reports_rls_user_scoped.sql`, applied to the live project 2026-09-18 on the owner's "proceed and make it work"; pre/post-checked. New `lab_reports` section above. | Claude | VTID-04044 |
| 2026-09-18 | `dev_autopilot_executions.metadata` gains three documented keys, no DDL (VTID-04032, cancel a running agent): `ecs_task_arn` + `dispatched_at` (written by the executor tick when the AWS `RunTask` dispatch succeeds, so a cancel can `StopTask` it), and `cancelled = { by, at, reason, was, ecs_task_arn?, ecs_task_stopped?, ecs_task_error? }` written by `POST /api/v1/dev-autopilot/executions/:id/cancel` on a `cooling` or `running` row (or by the agent itself, `by: "agent"`, when its own cancel check fires first). `status` moves to `cancelled` with `cancelled_at` in the same PATCH; a later result from the agent never overwrites it. | Claude | VTID-04032 |
| 2026-09-17 | `dev_autopilot_executions.status` CHECK widened with `awaiting_approval` (diff review before a PR, W4e): the agent executor pushes its branch and, when the row carries `metadata.require_approval` (or the executor runs with `DEV_AUTOPILOT_PR_APPROVAL_REQUIRED=true`), stops there with `metadata.pending_approval = { branch, base_sha, head_sha, pr_title, pr_body, session_id, staged_at, diff{stat,patch,files,…,truncated} }`; `POST /api/v1/dev-autopilot/executions/:id/approve` opens the PR and moves the row to `ci` (`metadata.approved`), `/reject` deletes the branch and moves it to `cancelled` (`metadata.rejected`). Migration `20260918000000_vtid_04029_dev_autopilot_executions_awaiting_approval.sql`, constraint change only, applied to the live project before merge (Migration Drift Check); inert until a row is actually held. | Claude | VTID-04029 |
| 2026-09-23 | Added `conversation_scoring_weights` (versioned shadow-score weights, version 1 seeded active). Migration `20260923200000_vtid_04422_conversation_scoring_weights.sql` **applied to the live project 2026-09-23** (additive). | Claude | VTID-04422 |
| 2026-09-23 | Added `conversation_offer_outcomes` (one row per offered action, settled by its first outcome) and `conversation_offer_outcome_stats()`. Migration `20260923190000_vtid_04421_conversation_offer_outcomes.sql` **applied to the live project 2026-09-23** (additive; empty at apply; RLS on, anon/authenticated verified without SELECT). | Claude | VTID-04421 |
| 2026-09-23 | `conversation_metrics_rollup_hour()` gains `context_setup_empty` / `context_setup_source` / `diag_core_snapshot_used` (migration `20260923160000`, applied live, 168 h re-rolled; baseline 52 of 157 signed-in sessions set up with no context). New `user_assistant_state` signal `brain_core_snapshot_v1` (no schema change). | Claude | VTID-04399 |
| 2026-09-23 | Added `conversation_metrics_hourly` plus `conversation_metrics_rollup_hour()` / `conversation_metrics_backfill()` and the pg_cron job `conversation-metrics-hourly`. Migration `20260923140000_vtid_04371_conversation_metrics_hourly.sql` **applied to the live project 2026-09-23**; 168 h backfilled in 1.3 s; the heaviest part (24 h opener-repeat join) measured at 3.4 ms on index range scans. | Claude | VTID-04371 |
| 2026-09-23 | Added `agent_runs` / `agent_run_steps` / `agent_run_signals` and the `agent_runs_unified` projection view; `agents_registry` agent-card columns + seed. Migration `20260923120000_vtid_04319_orchestrator_run_ledger.sql` **applied to the live project 2026-09-23** (additive; view unions 4,442 existing runs; anon/authenticated verified without SELECT). | Claude | VTID-04319 |
| 2026-09-17 | Added `operator_threads` / `operator_messages` (server-side Operator Console threads + rolling summaries, W4b). Migration `20260917230000_vtid_04022_operator_threads.sql` **applied to the live project 2026-09-17 22:20 UTC** (Supabase MCP `apply_migration`; pre/post-checked, both tables empty, RLS + service_role policy + indexes present) because the Migration Drift Check requires it before merge; gateway code stays fail-open and inert until `OPERATOR_THREADS_ENABLED` is pinned. | Claude | VTID-04022 |
| 2026-09-17 | Commerce Partner Onboarding landing: marked the `partner_organizations`/roster/`patient_profiles` section APPLIED (Phase A, VTID-03957); documented `partner_organizations.commerce_vertical` (VTID-03974) and the VTID-03995 `get_my_permitted_roles()`/`set_role_preference()` changes — both migrations applied to the live project 2026-09-17 on the platform owner's explicit instruction, post-checked (column + CHECK + comment present; both function bodies replaced, `validate_role_assignment()` no longer called from `set_role_preference()`). | Claude | VTID-03996 |
| 2026-09-17 | Added `service_bot_accounts` allowlist + guarded the VTID-03089 welcome-chat trigger and its `/auth/login` TS mirror against it. Two service/automation accounts (claude-code-agent, operator-autopilot) provisioned directly into `user_tenants` on 2026-09-16 fanned an identical intro DM out to 445 real community members — confirmed via read-only production query, nothing recalled. Migration `20260917084341_vtid_03990_service_bot_accounts_skip_welcome_chat.sql`. | Claude | VTID-03990 |
| 2026-09-13 | `dev_autopilot_outcomes.source_type` CHECK widened from the original `('dev_autopilot','dev_autopilot_impact')` pair to the full executor-lane allowlist (`missing-test-scanner`, `test-contract-failure-scanner`, `dev_autopilot`, `dev_autopilot_impact`, `operator_onramp`) — migration `20260913100000_vtid_03844_outcomes_source_type_allowlist.sql`. The constraint had never followed VTID-02984's single allowlist or VTID-03820's `operator_onramp`, and `recordOutcome()` carried its own copy of the stale pair, so operator on-ramp executions produced no outcome rows at all (observed on staging 2026-09-13). A gateway test reads the migration and fails if its list drifts from `EXECUTABLE_RECOMMENDATION_SOURCE_TYPES`. Migration ships as a file; apply via `RUN-MIGRATION.yml`. | Claude | VTID-03844 |
| 2026-07-21 | Added missing `wallet_transactions_from_user_id_fkey`/`_to_user_id_fkey` (NOT VALID, targeting `profiles.user_id`) — the Wallet's "Recent Activity" transaction list had never worked; every `fetchTransactions` PostgREST embed 400'd for lack of any FK on `from_user_id`/`to_user_id`. Found while verifying the VTNA/Credits merge deploy on AWS staging; unrelated pre-existing bug. Verified with a direct PostgREST request (200 OK, real profile data resolved). | Claude | — |
| 2026-07-20 | Merged VTNA and Credits into one "VTNA Credits" currency; stripped staking-APY/governance/appreciation copy (previous cause of an Apple 3.1.5(iii) rejection) from the two dedicated VTNA popups and every send/request/exchange/booking currency picker in vitana-v1; defensive DB migration folding any nonzero VTNA balance into CREDITS (no-op, verified). Also fixed an unrelated bug found in the same pass: `WalletMasterActionPopup`'s quick-action menu fabricated free balance and silently destroyed real USD balance via a fake withdrawal. | Claude | BOOTSTRAP-VTNA-CREDITS-MERGE |
| 2025-11-11 | Initial schema documentation | Claude | DEV-COMMU-0055 |
| 2025-11-11 | Fixed vtid_ledger vs VtidLedger mismatch | Claude | DEV-COMMU-0055 |
| 2025-12-31 | Added personalization_audit table for cross-domain personalization | Claude | VTID-01096 |
| 2025-12-31 | Added services_catalog, products_catalog, user_offers_memory, usage_outcomes, relationship_edges | Claude | VTID-01092 |
| 2026-01-03 | Added d44_predictive_signals, d44_signal_evidence, d44_intervention_history for proactive signal detection | Claude | VTID-01138 |
| 2026-01-03 | Added contextual_opportunities table for D48 opportunity surfacing | Claude | VTID-01142 |
| 2026-01-03 | Added risk_mitigations table for D49 Proactive Health & Lifestyle Risk Mitigation Layer | Claude | VTID-01143 |
| 2026-04-19 | Added ai_provider_policies, ai_assistant_credentials, ai_consent_log + extended connector_registry.category to include 'ai_assistant' | Claude | VTID-02403 |
| 2026-04-27 | Added routines + routine_runs tables for daily Claude Code remote-agent catalog and run history | Claude | VTID-01981 |
| 2026-04-28 | Added `pillar` + `contribution_vector` columns to `calendar_events` for typed Vitana Index linkage (replaces `pillar:*` wellness_tag heuristic on the frontend) | Claude | claude/vitana-index-navigation-VdSEQ |
| 2026-09-23 | Triggers `trg_event_participation_calendar` (global_event_participants → calendar_events) + `trg_calendar_dedupe_event_rsvp`, so community event sign-ups reach the calendar on every path. No table/column change. | Claude | VTID-04321 |
| 2026-09-23 | `calendar_events`: `rrule`, `timezone`, `reminder_offsets`, `emoji` + CHECKs; role_context adds `professional`; source_type adds six producer types. Also applied the never-applied 2026-04-28 `pillar`/`contribution_vector` migration. | Claude | VTID-04331 |
| 2026-09-23 | Producer triggers on `goal_plan_steps`, `goal_plans`, `user_health_plans`, `provider_appointments`, `lab_test_orders`, `live_room_sessions`, `live_room_access_grants` → `calendar_events` through one SQL upsert (`calendar_upsert_from_source`); future-only backfill (555 goal-plan entries, 3 health-plan series). No table/column change. | Claude | VTID-04356 |
| 2026-09-23 | New table `calendar_feed_tokens` (one private iCalendar subscription token per user, SHA-256 hash only; RLS on, no policies, no browser grants). | Claude | VTID-04358 |
| 2026-09-23 | New tables `calendar_google_sync`, `calendar_google_links`, `calendar_external_busy` for Google Calendar two-way sync (switched off). No tokens stored — they stay in `social_connections`. RLS on, no policies, no browser grants. | Claude | VTID-04372 |
| 2026-09-24 | New tables `calendar_push_targets`, `calendar_push_links`: Outlook and iCloud calendar push into a member-owned "Vitanaland" calendar. RLS on, no policies, no browser grants. | Claude | VTID-04436 |
| 2026-09-24 | `connected_app_settings.app_id` CHECK gains `outlook-contacts` (Outlook contacts import; rows land in `contacts` with `source='microsoft'`). | Claude | VTID-04449 |
| 2026-05-12 | Added `cover_url`, `cover_generated_at`, `cover_source` to `user_intents` for the Find-a-Match cover-photo flow (user upload OR server-side OpenAI Images generation OR curated fallback). Idx on `(requester_user_id, cover_generated_at)` for per-user rate-limit. | Claude | BOOTSTRAP-INTENT-COVER-GEN |
| 2026-05-20 | Added `decision_policy` + `policy_render_block` (Phase B.1 of decision-contract refactor). Versioned, tenant-aware, time-bounded externalized policy values + localized render fragments. Schema only — no consumer reads yet (lands in Phase B.4). | Claude | VTID-03113 |
| 2026-05-20 | Seeded Phase B vertical-proof rows: 5 `decision_policy` rows (session-recency bucket thresholds) + 64 `policy_render_block` rows (8 greeting buckets × 8 languages). English content authoritative; non-`en` rows carry `notes='seeded from en; awaiting translation'`. Still no consumer reads yet — that's Phase B.4. | Claude | VTID-03114 |
| 2026-05-21 | Seeded 9 voice-pipeline threshold rows in `decision_policy` (VAD silence 850ms, post-turn cooldown 2000ms, silence keepalive interval/idle 3000ms each, greeting/turn-response watchdogs 8000/10000ms, forwarding ack timeout 45000ms, loop guards 3/5) under `voice.vad.*`, `voice.post_turn.*`, `voice.silence_keepalive.*`, `voice.watchdog.*`, `voice.loop_guard.*`. Phase D.1 of decision-contract refactor. Accessor functions in `orb/upstream/constants.ts`. | Claude | VTID-03124 |
| 2026-05-21 | Seeded 8 `policy_render_block` rows under `voice.connection_issue` (one per language: en/de/fr/es/ar/zh/ru/sr) — externalizes the previously-inline `connectionIssueMessages` Record. Phase D.2 of decision-contract refactor. | Claude | VTID-03125 |
| 2026-05-21 | Seeded 8 `decision_policy` rows under `voice.live_api.voice.<lang>` with `{voice_name, fallback_lang}` JSON shape. Closes the audit's "silent Arabic → English Aoede" finding by emitting deduped `[voice-fallback]` warning whenever a non-native voice is selected. Phase D.3 of decision-contract refactor. | Claude | VTID-03126 |
| 2026-05-21 | Seeded 1 `decision_policy` row under `voice.cascade.default` with the 6-field cascade shape (stt/llm/tts × provider+model). Gateway `/orb/context-bootstrap` now returns this when no per-agent `agent_voice_configs` row exists — kills the silent Python all-Google fallback in `orb-agent/providers.py`. Phase D.4.a of decision-contract refactor. | Claude | VTID-03127 |
| 2026-05-21 | Added `provenance` JSONB column to `autopilot_recommendations` (nullable). Carries the `RankProvenance` trail (strategy_id + version + computed_at + tenant_id + components[] + final_score) Phase C strategies will emit. Schema + types only in this slice — Phase C.2 seeds ranker weights, C.3 implements `PillarWeighterStrategy`, C.4 wires `rankBatch()` to persist provenance. | Claude | VTID-03130 |
| 2026-05-21 | Seeded 21 ranker policy rows in `decision_policy` under `ranker.pillar_weighter.*` — 10 weights/dampeners, 3 balance thresholds, 6 journey-mode decay curve points, 2 misc (compass decay, pillar score cap). Phase C.2 of decision-contract refactor. Values byte-identical to `DEFAULT_RANKER_CONFIG` + inline literals in `index-pillar-weighter.ts`. Consumers land in Phase C.3 / C.5+. | Claude | VTID-03131 |
| 2026-06-01 | Added `seed_community_onboarding_autopilot(uuid)` function + `seed_onboarding_autopilot_on_primary_membership` AFTER INSERT trigger on `user_tenants` (WHEN `is_primary=true`). Seeds the day0 community onboarding Autopilot bundle (8 `onboarding_*` rows in `autopilot_recommendations`) on signup — bypass-proof, since vitana-v1 authenticates directly via Supabase Auth and never hit the gateway `/auth/login` first-login hook (same root cause + trigger pattern as VTID-03089 welcome chat). Mirrors `STAGE_TEMPLATES.day0` in `community-user-analyzer.ts` (drift-guarded by `autopilot-onboarding-seed-bundle.test.ts`); fingerprints match the TS generator so the cron/lazy-gen dedupe against the seed. Idempotent + fail-soft. Includes a 7-day backfill of recent zero-rec community members. | Claude | BOOTSTRAP-ONBOARDING-AUTOPILOT-SEED |
| 2026-06-07 | Added Video Shop (Vitanaland) backend slice: `shop_videos`, `shop_video_anchors` (single-primary index), `shop_saved_products`, `shop_video_events` (non-OASIS funnel sink). Threaded `source_video_id`/`source_creator_id` attribution onto `universal_cart_items` + `product_orders` and widened the `source_surface` CHECK to admit `video_shop`. New surface over `products` + Universal Cart — no second commerce system; no wallet buy-now in V1. | Claude | VTID-03237 |
| 2026-07-17 | Documented the live wallet system (`user_wallets`, `wallet_transactions`, `exchange_rates` — previously undocumented). Fixed a critical vuln: `update_user_balance`/`process_wallet_exchange`/`process_wallet_transfer`/`process_wallet_exchange_and_send` let any authenticated user debit/credit an arbitrary `user_id`; added `auth.uid()` ownership checks and made the exchange RPCs read the server-side `exchange_rates` row instead of trusting a client-supplied rate. Real-world-launch reset: zeroed all 209 users' USD/CREDITS/VTNA balances (archived pre-reset values in new `wallet_balance_resets` table); changed `initialize_user_wallet()`/`get_user_balance()`/`user_wallets.balance` default from seeding `1000.00` to `0.00`. Flagged the `wallet_transactions`/`wallet_balances` "Credits ledger" from VTID-01250 as dead code — it never took effect due to a table-name collision. | Claude | BOOTSTRAP-WALLET-RESET |
| 2026-07-20 | Bridged the real Stripe deposit flow (`credit_deposit`) to also credit the legacy `user_wallets` balance the wallet UI reads, and fixed its Stripe success/cancel redirect URLs, which pointed at SPA routes that never existed. Separately, fixed a TOCTOU race shared by all four wallet-mutating RPCs (`update_user_balance`/`process_wallet_exchange`/`process_wallet_transfer`/`process_wallet_exchange_and_send`) by replacing SELECT-then-UPDATE with a single atomic `UPDATE ... WHERE balance >= amount`; gave `update_user_balance` the ability to log to `wallet_transactions` (added `'withdrawal'`/`'stake'` to the type CHECK) so Withdraw/Stake/Spend actions stop leaving zero transaction history. | Claude | BOOTSTRAP-WALLET-RESET |

---

### calendar_events (Vitana Index linkage columns)

**Purpose:** Typed columns added to the existing `calendar_events` table so the frontend can render per-event pillar chips and the calendar "Today's Index pulse" strip without falling back to `pillar:*` entries inside `wellness_tags`. Both columns are nullable so legacy rows continue working.

**Used by:** `services/gateway/src/types/calendar.ts`, `services/gateway/src/services/calendar-service.ts`. Frontend consumer: `src/components/calendar/EnhancedCalendarPopup.tsx` (vitana-v1).

**Migration:** `supabase/migrations/20260428000000_calendar_pillar_contribution_vector.sql`

**Columns added:**
```sql
ALTER TABLE calendar_events ADD COLUMN pillar TEXT;
ALTER TABLE calendar_events ADD COLUMN contribution_vector JSONB;

ALTER TABLE calendar_events ADD CONSTRAINT valid_pillar
  CHECK (pillar IS NULL OR pillar IN
    ('nutrition', 'hydration', 'exercise', 'sleep', 'mental'));

-- contribution_vector: object whose keys are the 5 canonical pillars.
-- Postgres rejects subqueries inside CHECK, so we validate by key-stripping:
-- removing every allowed key with `-` and asserting the remainder is empty.
-- Value-level validation (non-negative numbers) is enforced by the gateway
-- Zod schema since CHECK can't iterate values without a subquery either.
ALTER TABLE calendar_events ADD CONSTRAINT valid_contribution_vector
  CHECK (
    contribution_vector IS NULL
    OR (jsonb_typeof(contribution_vector) = 'object'
        AND (contribution_vector
             - 'nutrition' - 'hydration' - 'exercise'
             - 'sleep' - 'mental') = '{}'::jsonb)
  );

CREATE INDEX idx_calendar_events_pillar_upcoming
  ON calendar_events (user_id, pillar, start_time)
  WHERE pillar IS NOT NULL AND status != 'cancelled';
```

**Backfill:** the migration extracts the first `pillar:<key>` entry from `wellness_tags` into the new `pillar` column for legacy rows that already had the heuristic tag, using `UNNEST(...) WITH ORDINALITY` + `DISTINCT ON` so the choice is deterministic when an event has multiple pillar tags.

**Notes:** the frontend's `derivePillar` helper now reads `event.pillar` first; falls back to the existing `wellness_tags` and `event_type` heuristic when both new columns are null.

### calendar_events — recurrence, reminders, emoji, lenses (VTID-04331)

Migration `20260923130000_vtid_04331_calendar_data_model.sql`, applied live 2026-09-23.

| Column | Type | Meaning |
|---|---|---|
| `rrule` | TEXT | RFC 5545 RRULE body without DTSTART (`FREQ=DAILY\|WEEKLY\|MONTHLY`, `INTERVAL`, `COUNT`, `UNTIL` in UTC, `BYDAY`). `start_time` is DTSTART; every occurrence has `end_time - start_time` duration. Expanded by the gateway (`services/calendar-recurrence.ts`). CHECK `valid_rrule`. |
| `timezone` | TEXT | IANA zone the rule is expanded in; NULL = the user's zone. |
| `reminder_offsets` | INTEGER[] | Minutes before start to remind; NULL = category default, `{}` = none. ≤5 values, 0..40320. CHECK `valid_reminder_offsets`. |
| `emoji` | TEXT | Display emoji; NULL = category default. CHECK `valid_emoji`. |

`valid_role_context` now allows `community, professional, admin, developer, personal`; `valid_source_type` adds `health_plan, lab_order, appointment, live_room, goal_plan, guided_journey`. Index `idx_calendar_events_recurring (user_id) WHERE rrule IS NOT NULL AND status <> 'cancelled'`.

**Note (2026-09-23):** the `pillar` / `contribution_vector` columns documented above were not present in the live database until VTID-04331 applied `20260428000000_calendar_pillar_contribution_vector.sql`; its backfill matched 0 rows.

### reminders ← calendar_events (VTID-04338 default reminders)

Migration `20260923140000_vtid_04338_calendar_default_reminders.sql`, applied live 2026-09-23.

| Column | Type | Meaning |
|---|---|---|
| `calendar_occurrence_start` | TIMESTAMPTZ | Start of the calendar occurrence this reminder is for (a recurring entry has many). NULL for voice/UI reminders. |
| `reminder_offset_minutes` | INTEGER | Minutes before `calendar_occurrence_start` the reminder fires. |

Unique index `uniq_reminders_calendar_occurrence_offset (calendar_event_id, calendar_occurrence_start, reminder_offset_minutes)` — deliberately not partial, so PostgREST `on_conflict` can upsert against it; voice/UI rows have NULLs there and never collide. Index `idx_reminders_calendar_pending (calendar_event_id) WHERE calendar_event_id IS NOT NULL AND status = 'pending'`.

Written by the gateway's `services/calendar-reminders.ts` loop (`CALENDAR_DEFAULT_REMINDERS_ENABLED=true`, every 60 s): one `created_via='system'` row per (entry, occurrence in the next 36 h, offset). Defaults: meeting/event 10 min, workout 30 min, lab test the evening before at 19:00 local + 1 h before, habit/nutrition/autopilot at start; an entry's own `reminder_offsets` win and `{}` means none. Pending rows whose entry moved, was cancelled, completed or deleted are cancelled on the next pass. Delivery is the existing reminders tick.

### calendar_events ← global_event_participants (VTID-04321 triggers)

**Purpose:** community event sign-ups land in the calendar on every path (web, voice `rsvp_event`, tickets). Migration `20260923120000_vtid_04321_rsvp_calendar_global_events.sql`, applied live 2026-09-23.

- `trg_event_participation_calendar` — AFTER INSERT / UPDATE OF status / DELETE on `global_event_participants` → `fn_event_participation_to_calendar()`. Joining (`status='attending'`) inserts one row: `event_type='community'`, `source_type='community_rsvp'`, `source_ref_id=<event id>`, `source_ref_type='community_event'`, `metadata={meetup_id, meetup_slug}`, `end_time` defaulting to start + 1 h; skipped when a live row for that user+event exists; a cancelled one is reactivated. Leaving cancels every live row matching `source_ref` or `metadata.meetup_id`.
- `trg_calendar_dedupe_event_rsvp` — AFTER INSERT on `calendar_events` for rows carrying `metadata.meetup_id` from any other source → deletes the trigger-written `community_rsvp` row for the same user+event, so the web client's own row (which it knows how to delete) is the one that stays.
- The older `trg_rsvp_calendar_sync` / `trg_rsvp_cancel_calendar_sync` on `event_attendance` remain; that table is unused (0 rows).

### calendar_feed_tokens (VTID-04358)

**Purpose:** the private iCalendar subscription link (`GET /api/v1/calendar/feed/<token>.ics`) that lets Apple/Google/Outlook subscribe to a user's Vitanaland calendar. Migration `20260923170000_vtid_04358_calendar_feed_tokens.sql`, applied live 2026-09-23.

| Column | Type | Notes |
|---|---|---|
| `user_id` | uuid PK | FK `auth.users(id)` ON DELETE CASCADE — one link per user; a new link replaces the old |
| `token_hash` | text UNIQUE NOT NULL | SHA-256 hex of the 256-bit token (`CHECK ~ '^[0-9a-f]{64}$'`); the plain token is returned once and never stored |
| `created_at` | timestamptz | when the current link was made |
| `last_used_at` | timestamptz | last feed fetch (best effort) |

RLS enabled with no policies; `ALL` revoked from `PUBLIC`/`anon`/`authenticated` — the gateway (service role) is the only reader/writer. The feed carries the user's own entries (title, time, place only — no descriptions, no alarms); work-lens items are not rows and never appear.

### calendar_google_sync / calendar_google_links / calendar_external_busy (VTID-04372)

**Purpose:** Google Calendar two-way sync. Built, switched off (`CALENDAR_GOOGLE_SYNC_ENABLED` exactly `true` + the Google OAuth client). Push: the member's own community/personal entries go to a "Vitanaland" calendar the app creates in their Google account (scope `calendar.app.created`, so no other Google calendar is ever touched). Pull: only free/busy of their Google primary calendar (scope `calendar.freebusy`), shown as grey busy blocks. OAuth tokens are **not** here — they stay in `social_connections` (provider `google`). Migration `20260923180000_vtid_04372_calendar_google_sync.sql`, applied live 2026-09-23.

`calendar_google_sync` — one row per member:

| Column | Type | Notes |
|---|---|---|
| `user_id` | uuid PK | FK `auth.users(id)` ON DELETE CASCADE |
| `enabled` | boolean NOT NULL default false | member turned sync on |
| `google_calendar_id` | text | the app-created Vitanaland calendar; NULL = create on next run |
| `last_push_at`, `last_pull_at` | timestamptz | last successful run |
| `last_error` | text | last failure, cleared on success |
| `created_at`, `updated_at` | timestamptz | |

`calendar_google_links` — one row per pushed entry: `id` uuid PK, `user_id` uuid FK, `calendar_event_id` uuid UNIQUE FK `calendar_events(id)` **ON DELETE SET NULL** (a deleted entry's Google copy is removed on the next run, then the row), `google_event_id` text, `pushed_hash` text (SHA-256 of the pushed event body; unchanged → no write), `pushed_at`.

`calendar_external_busy` — busy intervals, replaced wholesale per pull: `id` uuid PK, `user_id` uuid FK, `source` text CHECK in (`google`), `start_time`, `end_time` (CHECK end > start), `fetched_at`. Times only — no titles, no attendees. Index `(user_id, start_time)`.

All three: RLS enabled with no policies; `ALL` revoked from `PUBLIC`/`anon`/`authenticated` — the gateway (service role) is the only reader/writer.

### calendar_events ← plans, bookings, orders, rooms (VTID-04356 triggers)

**Purpose:** every accepted plan, paid booking, lab order and live-room ticket lands in the owner's calendar, whichever path wrote it (gateway, edge function, Stripe webhook, frontend). Migration `20260923160000_vtid_04356_calendar_source_producers.sql`, applied live 2026-09-23.

Helpers (SECURITY DEFINER, `EXECUTE` revoked from `anon`/`authenticated`/`PUBLIC`):
- `calendar_upsert_from_source(user, source_type, ref_type, ref_id, title, start, end, event_type, description, location, emoji, rrule, timezone, pillar, role_context, metadata)` — idempotent on `idx_calendar_events_source_ref`; never changes a completed entry; reactivates a cancelled one; does not rewrite an unchanged one.
- `calendar_cancel_source(user, ref_type, ref_id)`, `calendar_complete_source(user, ref_type, ref_id, done)`.
- `calendar_user_timezone(user)` — `profiles.timezone`, else `Europe/Berlin`.
- `calendar_sync_goal_plan_step`, `calendar_sync_health_plan`, `calendar_sync_appointment`, `calendar_sync_lab_order`, `calendar_sync_live_room_entry` — one per source.

| Source table | Trigger | Entry | `source_type` / `source_ref_type` |
|---|---|---|---|
| `goal_plan_steps` | `trg_goal_plan_step_calendar` | milestone/checkpoint → 09:00 local on `scheduled_date`; habit → daily series 08:00 local (+30 min per earlier habit) from plan start to target; done ↔ completed (not for habits); `calendar_event_id` set on the step | `goal_plan` / `goal_plan_step` |
| `goal_plans` | `trg_goal_plan_calendar` | leaving `active` cancels the steps' open entries; returning to `active` restores them | — |
| `user_health_plans` | `trg_health_plan_calendar` | active → daily series (`COUNT` from `plan_data.duration`, default 28) at a time fitting `plan_type`; inactive/deleted → cancelled | `health_plan` / `user_health_plan` |
| `provider_appointments` | `trg_appointment_calendar` | `scheduled`/`confirmed` → entry; `pending` (unpaid checkout) never shows; `completed` → completed; anything else → cancelled | `appointment` / `provider_appointment` |
| `lab_test_orders` | `trg_lab_order_calendar` | `confirmed` with `scheduled_date` → lab entry (lab reminder rules); `sample_collected`/`processing`/`completed` → completed; `cancelled`/`pending` → cancelled | `lab_order` / `lab_test_order` |
| `live_room_sessions` | `trg_live_room_session_calendar` | host + every valid ticket holder; moving/renaming updates all; `cancelled` cancels all; `ended` left as is | `live_room` / `live_room_session` |
| `live_room_access_grants` | `trg_live_room_grant_calendar` | valid ticket → the session in the holder's calendar; revoked/invalid/deleted → cancelled unless another valid ticket remains | `live_room` / `live_room_session` |

Every trigger body catches its own errors (`RAISE WARNING`) so a calendar failure never fails the source write. Backfill at apply time wrote future items only: 555 goal-plan entries for 22 users (61 habit series) and 3 health-plan series; no appointments, lab orders or live-room sessions were in the future. `partner_health_test_orders` is not connected (no appointment time exists).

---

### contextual_opportunities
**Purpose:** Contextual opportunities surfaced to users based on their current life context and predictive windows (D48)
**Used by:** `services/gateway/src/services/d48-opportunity-surfacing-engine.ts` and `services/gateway/src/routes/opportunity-surfacing.ts`

**Schema:**
```sql
CREATE TABLE contextual_opportunities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  user_id UUID NOT NULL,
  session_id TEXT,
  opportunity_type TEXT NOT NULL,  -- Values: experience, service, content, activity, place, offer
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  confidence INTEGER NOT NULL,     -- 0-100
  why_now TEXT NOT NULL,           -- Mandatory explanation for transparency
  relevance_factors TEXT[] NOT NULL DEFAULT '{}',
  suggested_action TEXT NOT NULL DEFAULT 'view',  -- Values: view, save, dismiss
  dismissible BOOLEAN NOT NULL DEFAULT TRUE,
  priority_domain TEXT NOT NULL,   -- Priority order: health > social > learning > exploration > commerce
  external_id TEXT,
  external_type TEXT,
  window_id TEXT,
  guidance_id TEXT,
  alignment_signal_ids TEXT[] DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'active',  -- Values: active, dismissed, engaged, expired
  dismissed_at TIMESTAMPTZ,
  dismissed_reason TEXT,
  engaged_at TIMESTAMPTZ,
  engagement_type TEXT,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

**API Endpoints:**
- `POST /api/v1/opportunities/surface` - Surface opportunities based on context
- `GET /api/v1/opportunities/active` - Get active opportunities
- `GET /api/v1/opportunities/history` - Get opportunity history
- `GET /api/v1/opportunities/stats` - Get surfacing statistics
- `POST /api/v1/opportunities/:id/dismiss` - Dismiss an opportunity
- `POST /api/v1/opportunities/:id/engage` - Record engagement with opportunity

**OASIS Events:**
- `opportunity.surfaced` - Opportunities surfaced for user
- `opportunity.dismissed` - Opportunity dismissed by user
- `opportunity.engaged` - User engaged with opportunity

**Hard Governance:**
- User-benefit > monetization
- Explainability mandatory (why_now field required)
- No dark patterns
- No urgency manipulation
- No scarcity framing

---

### risk_mitigations
**Purpose:** D49 Proactive Health & Lifestyle Risk Mitigation Layer - stores generated mitigation suggestions (VTID-01143)
**Used by:**
- `services/gateway/src/services/d49-risk-mitigation-engine.ts` (CRUD operations)
- `services/gateway/src/routes/risk-mitigation.ts` (API endpoints)

**Schema:**
```sql
CREATE TABLE risk_mitigations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  user_id UUID NOT NULL,
  risk_window_id UUID NOT NULL,
  domain TEXT NOT NULL,  -- Values: sleep, nutrition, movement, mental, routine, social
  confidence INTEGER NOT NULL CHECK (confidence >= 0 AND confidence <= 100),
  suggested_adjustment TEXT NOT NULL,  -- Plain language suggestion
  why_this_helps TEXT NOT NULL,  -- Short explanation
  effort_level TEXT NOT NULL DEFAULT 'low',  -- Always 'low' for D49
  source_signals UUID[] DEFAULT '{}',
  precedent_type TEXT,  -- Values: user_history, general_safety
  disclaimer TEXT NOT NULL,  -- Safety disclaimer
  status TEXT NOT NULL DEFAULT 'active',  -- Values: active, dismissed, acknowledged, expired, superseded
  expires_at TIMESTAMPTZ,
  dismissed_at TIMESTAMPTZ,
  acknowledged_at TIMESTAMPTZ,
  dismiss_reason TEXT,  -- Values: not_relevant, already_doing, not_now, no_reason
  generated_by_version TEXT NOT NULL,
  input_hash TEXT NOT NULL,  -- For determinism verification
  suggestion_hash TEXT NOT NULL,  -- For cooldown deduplication
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

**API Endpoints:**
- `POST /api/v1/mitigation/generate` - Generate mitigations from risk windows
- `POST /api/v1/mitigation/dismiss` - Dismiss a mitigation
- `POST /api/v1/mitigation/acknowledge` - Acknowledge a mitigation (mark as viewed)
- `GET /api/v1/mitigation/active` - Get active mitigations for current user
- `GET /api/v1/mitigation/history` - Get mitigation history
- `POST /api/v1/mitigation/expire` - Expire old mitigations (admin)
- `GET /api/v1/mitigation/health` - Health check
- `GET /api/v1/mitigation/config` - Get configuration
- `GET /api/v1/mitigation/domains` - Get available domains
- `GET /api/v1/mitigation/disclaimer` - Get safety disclaimer

**OASIS Events:**
- `risk_mitigation.generated` - Mitigation generated
- `risk_mitigation.dismissed` - Mitigation dismissed
- `risk_mitigation.acknowledged` - Mitigation acknowledged
- `risk_mitigation.expired` - Mitigation expired
- `risk_mitigation.skipped` - Mitigation skipped (cooldown/threshold)
- `risk_mitigation.error` - Error during generation

**Hard Governance:**
- Safety > optimization
- No diagnosis, no treatment
- No medical claims
- Suggestions only, never actions
- Explainability mandatory
- All outputs logged to OASIS

---

## 🎭 VISUAL VERIFICATION DATA STRUCTURES

### Visual Verification Result (VTID-01200)
**Purpose:** Post-deploy visual testing results stored in `verification_result` JSONB field
**Used by:**
- `services/gateway/src/services/visual-verification.ts` (Visual testing service)
- `services/gateway/src/services/autopilot-verification.ts` (Verification orchestrator)
- `services/mcp-gateway/src/connectors/playwright-mcp.ts` (Browser automation)

**Data Structure:**
```typescript
interface VisualVerificationResult {
  passed: boolean;                    // Overall pass/fail
  page_load_passed: boolean;          // Can page load without errors?
  journeys_passed: boolean;           // All user journeys passed?
  accessibility_passed: boolean;      // WCAG compliance check
  screenshots: string[];              // Base64 encoded screenshots
  journey_results: JourneyResult[];   // Individual journey test results
  accessibility_violations: Array<{   // A11y violations found
    id: string;
    impact: string;
    description: string;
  }>;
  issues: string[];                   // List of issues found
  verified_at: string;                // ISO timestamp
}

interface JourneyResult {
  name: string;                       // Journey name (e.g., "homepage_load")
  passed: boolean;                    // Journey pass/fail
  steps_passed: number;               // Number of steps that passed
  steps_failed: number;               // Number of steps that failed
  duration_ms: number;                // Journey execution time
  errors: string[];                   // List of error messages
}
```

**Journey Definitions:**
- **Frontend journeys** (domain === 'frontend'):
  - `homepage_load` (critical) - Homepage loads without errors
  - `navigation_sidebar` - Sidebar navigation exists
  - `messages_page` - Messages page loads
  - `health_page` - Health page loads

- **Backend journeys** (domain === 'backend' | 'api'):
  - `api_health_check` (critical) - /alive endpoint returns healthy

**Integration:**
- Visual verification runs as Step 4 in `runVerification()` after acceptance assertions
- Results stored in `vtid_ledger.metadata.verification_result.visual_verification_result`
- Emits OASIS events: `autopilot.verification.visual.{started|completed|failed}`
- Non-blocking: Visual test failures are warnings, not blockers

**Environment Variables:**
```bash
MCP_GATEWAY_URL=http://localhost:3001          # MCP Gateway endpoint
FRONTEND_URL=https://temp-vitana-v1.lovable.app # Frontend URL for testing
VISUAL_TEST_SCREENSHOTS_DIR=/tmp/visual-tests  # Screenshot storage directory
PLAYWRIGHT_HEADLESS=true                        # Run browser in headless mode
PLAYWRIGHT_VIEWPORT_WIDTH=1280                  # Browser viewport width
PLAYWRIGHT_VIEWPORT_HEIGHT=720                  # Browser viewport height
PLAYWRIGHT_TIMEOUT=30000                        # Test timeout in ms
```

---

## VTID-02403 — AI Subscription Connect Phase 1

Added 2026-04-19 by VTID-02403 migration `20260419000000_vtid_02403_ai_assistants_phase1.sql`.

### ai_provider_policies
**Purpose:** Per-tenant × provider AI policy (allowed, allowed_models, cost cap, memory categories).
**Used by:** `services/gateway/src/routes/ai-assistants.ts`, `services/gateway/src/routes/admin/ai-integrations.ts`

```sql
CREATE TABLE ai_provider_policies (
  tenant_id UUID NOT NULL,
  provider TEXT NOT NULL,                 -- 'chatgpt' | 'claude'
  allowed BOOLEAN NOT NULL DEFAULT TRUE,
  allowed_models TEXT[] NOT NULL DEFAULT '{}',
  cost_cap_usd_month NUMERIC(10,2) NOT NULL DEFAULT 50,
  allowed_memory_categories TEXT[] NOT NULL DEFAULT '{}',
  updated_by UUID,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, provider)
);
```
RLS: `SELECT` for any authenticated user whose `user_tenants.tenant_id` matches; `ALL` for `service_role`.

---

### ai_assistant_credentials
**Purpose:** Encrypted per-user API keys for AI assistants (AES-256-GCM, key lives in `AI_CREDENTIALS_ENC_KEY` env var on Cloud Run).
**Used by:** `services/gateway/src/routes/ai-assistants.ts`

```sql
CREATE TABLE ai_assistant_credentials (
  connection_id UUID PRIMARY KEY REFERENCES user_connections(id) ON DELETE CASCADE,
  encrypted_key BYTEA NOT NULL,           -- AES-256-GCM ciphertext (NEVER returned via API)
  key_prefix TEXT NOT NULL,               -- e.g. 'sk-' or 'sk-ant-'
  key_last4 TEXT NOT NULL,                -- last 4 chars for display
  encryption_iv BYTEA NOT NULL,
  encryption_tag BYTEA NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_verified_at TIMESTAMPTZ,
  last_verify_status TEXT,                -- 'ok' | 'unauthorized' | 'network' | 'error' | 'purged'
  last_verify_error TEXT,
  verify_failure_count INT NOT NULL DEFAULT 0
);
```
RLS: `SELECT` allowed only via join to `user_connections.user_id = auth.uid()`; `ALL` for service role.
**SECURITY:** The route layer NEVER returns `encrypted_key`. Only `key_prefix` and `key_last4` are exposed.

---

### ai_consent_log
**Purpose:** Append-only audit of AI connect/disconnect/verify/policy events.
**Used by:** `services/gateway/src/routes/ai-assistants.ts`, `services/gateway/src/routes/admin/ai-integrations.ts`

```sql
CREATE TABLE ai_consent_log (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID,
  tenant_id UUID,
  provider TEXT,
  action TEXT NOT NULL,                   -- 'connect'|'disconnect'|'verify_ok'|'verify_failed'|'policy_update'
  before_jsonb JSONB,
  after_jsonb JSONB,
  actor_role TEXT,                        -- 'user'|'operator'|'service'
  actor_id UUID,
  ts TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```
RLS: users see their own; service role full.

---

**connector_registry** (pre-existing): extended `category` CHECK constraint to include `'ai_assistant'`; seeded rows `id='chatgpt'` and `id='claude'` with `auth_type='api_key'` and `capabilities=['chat','reasoning']`.

---

### profiles
**Purpose:** Canonical per-user profile — identity, contact, and account data surfaced in the MAXINA profile card (Identity | Social | Account pills).
**Owned by:** Community app (`vitana-v1`), writes via Supabase client.
**Migration:** `vitana-v1/supabase/migrations/20260421000000_add_account_profile_fields.sql`

**Account tab — fields + per-field visibility:**

| Column | Type | Notes |
|--------|------|-------|
| `first_name` | TEXT | Basic Personal Information |
| `last_name` | TEXT | Basic Personal Information |
| `date_of_birth` | DATE | Pre-existing; exposed in Account tab |
| `gender` | TEXT | free-form |
| `marital_status` | TEXT | free-form |
| `email` | TEXT | Pre-existing |
| `phone` | TEXT | Pre-existing |
| `address` | TEXT | Contact Information |
| `country` | TEXT | Contact Information |
| `city` | TEXT | Contact Information |
| `account_type` | TEXT | e.g. `Community`, `Professional` |
| `verification_status` | TEXT | CHECK (`unverified` \| `pending` \| `verified`) |
| `account_visibility` | JSONB | Per-field visibility rule, key → `private` \| `connections` \| `public` |

**Default `account_visibility`:** sensitive fields (names, DOB, contact) default to `private`; `country`/`city` default to `connections`; `member_since` / `account_type` / `verification_status` default to `public`.

**Design principle:** Each field has BOTH a value and a visibility rule. Non-owners only see fields flagged `public`.

---

## VTID-01981 — Routines (daily Claude Code remote-agent catalog)

### routines
**Purpose:** Catalog of every daily Claude Code remote agent ("routine") that runs on a cron schedule in an isolated sandbox. Surfaces in the Command Hub `Routines` section.
**Used by:** `services/gateway/src/routes/routines.ts`, Command Hub `routines/catalog/` and `routines/history/` tabs.
**Migration:** `supabase/migrations/20260427130000_vtid_01981_routines_catalog.sql`

**Schema:**
```sql
CREATE TABLE routines (
  name                  TEXT PRIMARY KEY,
  display_name          TEXT NOT NULL,
  description           TEXT,
  cron_schedule         TEXT NOT NULL,
  enabled               BOOLEAN NOT NULL DEFAULT TRUE,
  last_run_id           UUID,
  last_run_at           TIMESTAMPTZ,
  last_run_status       TEXT CHECK (last_run_status IN ('running','success','failure','partial')),
  last_run_summary      TEXT,
  consecutive_failures  INTEGER NOT NULL DEFAULT 0,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### routine_runs
**Purpose:** Per-execution record for a routine — start/finish timestamps, status, headline summary, structured findings JSON, and any artifacts (PR URLs, GitHub issue links).
**Used by:** Same as `routines`. Routines POST a row at start (`status='running'`) and PATCH it at finish with the final status + findings.
**Migration:** Same as `routines`.

**Schema:**
```sql
CREATE TABLE routine_runs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  routine_name  TEXT NOT NULL REFERENCES routines(name) ON DELETE CASCADE,
  started_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at   TIMESTAMPTZ,
  status        TEXT NOT NULL CHECK (status IN ('running','success','failure','partial')),
  trigger       TEXT NOT NULL DEFAULT 'cron' CHECK (trigger IN ('cron','manual')),
  summary       TEXT,
  findings      JSONB,
  artifacts     JSONB,
  error         TEXT,
  duration_ms   INTEGER,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_routine_runs_routine_started ON routine_runs(routine_name, started_at DESC);
CREATE INDEX idx_routine_runs_status          ON routine_runs(status);
```

**Auth model:** GET endpoints reuse Command Hub auth. POST/PATCH require `X-Routine-Token: $ROUTINE_INGEST_TOKEN` (shared secret env var on the gateway), so a remote sandbox routine can authenticate without a user JWT.

---

## VTID-03113 — Decision-Contract Phase B (externalized policy)

These two tables externalize the ~140 hard-coded constants and ~30 hard-coded ladders the May 2026 contextual-intelligence audit found scattered across the renderer, ranker, fusion engine, and voice layers. Phase B.1 introduces the **schema only** — no code reads from these tables yet. Reads land in Phase B.4 (vertical proof on the temporal-bucket greeting block in `services/gateway/src/orb/live/instruction/live-system-instruction.ts`).

### decision_policy
**Purpose:** Versioned, tenant-aware, time-bounded numeric/enum/JSON policy values. One row per `(policy_key, tenant_id, version)`. Replaces hard-coded literals across decision-producing code paths.
**Used by:** `services/gateway/src/services/decision-contract/policy-resolver.ts` (lands in Phase B.3; nothing today).
**Migration:** `supabase/migrations/20260527000000_VTID_03113_decision_policy.sql`

**Resolver contract:** for a given `(policy_key, tenant_id, now)`, pick the highest `version` row where `effective_from <= now AND (effective_until IS NULL OR effective_until > now)`. Tenant-specific row wins over `tenant_id IS NULL`.

**Schema:**
```sql
CREATE TABLE decision_policy (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  policy_key      TEXT NOT NULL,         -- e.g. session.recency_bucket.reconnect_max_seconds
  tenant_id       UUID,                  -- NULL = global default
  version         INTEGER NOT NULL,
  value_json      JSONB NOT NULL,
  effective_from  TIMESTAMPTZ NOT NULL DEFAULT now(),
  effective_until TIMESTAMPTZ,
  source          TEXT NOT NULL DEFAULT 'seed'
    CHECK (source IN ('seed','admin_ui','autopilot','experiment')),
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by      TEXT,
  UNIQUE (policy_key, tenant_id, version)
);
CREATE INDEX decision_policy_lookup_idx
  ON decision_policy (policy_key, tenant_id, effective_from DESC);
```

**Auth model:** RLS enabled. `service_role` bypasses RLS (Supabase default) — the resolver runs as service. Authenticated app role has `SELECT` only, scoped to global defaults (`tenant_id IS NULL`) plus rows whose `tenant_id` is in `user_tenants` for the caller. No INSERT/UPDATE/DELETE policy for authenticated.

### policy_render_block
**Purpose:** Versioned, tenant-aware, localized prompt fragments. Sibling of `decision_policy`: carries verbatim text the renderer concatenates or the model echoes (greeting lines, instruction blocks).
**Used by:** Same as `decision_policy` (Phase B.3 resolver; nothing today).
**Migration:** `supabase/migrations/20260527010000_VTID_03113_policy_render_block.sql`

**Resolver contract:** identical to `decision_policy`, keyed by `(block_key, language, tenant_id, now)`.

**Schema:**
```sql
CREATE TABLE policy_render_block (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  block_key       TEXT NOT NULL,         -- e.g. greeting.bucket.today
  language        TEXT NOT NULL,         -- en, de, fr, es, ar, zh, ru, sr
  tenant_id       UUID,                  -- NULL = global default
  version         INTEGER NOT NULL,
  content         TEXT NOT NULL,
  effective_from  TIMESTAMPTZ NOT NULL DEFAULT now(),
  effective_until TIMESTAMPTZ,
  source          TEXT NOT NULL DEFAULT 'seed'
    CHECK (source IN ('seed','admin_ui','autopilot','experiment')),
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by      TEXT,
  UNIQUE (block_key, language, tenant_id, version)
);
CREATE INDEX policy_render_block_lookup_idx
  ON policy_render_block (block_key, language, tenant_id, effective_from DESC);
```

**Auth model:** Same as `decision_policy` (RLS-on, `service_role` bypass, authenticated SELECT only).

**Phase plan (each its own VTID + PR):**
1. B.1 — schema (this VTID, VTID-03113).
2. B.2 — seed migration (5 `decision_policy` rows + 64 `policy_render_block` rows = 8 buckets × 8 languages).
3. B.3 — `PolicyResolver` service, cache warm-up, telemetry, `policy-keys.ts`.
4. B.4 — vertical proof: migrate `live-system-instruction.ts` greeting block to read via the resolver.

See `docs/decision-contract/phase-b-brief.md` for the full plan.

---

## VTID-03237 — Video Shop (Vitanaland)

A NEW SURFACE over the existing `products` catalog + Universal Cart + (later) the
EUR/USD wallet. It forks nothing: the drawer's add-to-cart calls
`/api/v1/universal-cart/items` with `source_surface='video_shop'`. V1 = curated/admin
videos, single anchor, drawer, add-to-cart, save, share, PDP — **no** wallet buy-now
(no checkout bridge yet), **no** open seller upload, **no** affiliate payout math.
**Migration:** `supabase/migrations/20260607000000_VTID_03237_video_shop_schema.sql`
**Used by:** `services/gateway/src/routes/shop-feed.ts` (+ `universal-cart.ts` attribution)

### shop_videos
**Purpose:** Curated vertical short clips that back the Video Shop feed. Feed-eligible only when `status='active'` AND `moderation_status='approved'` AND it has a primary anchor whose product is active/in_stock.

**Schema:**
```sql
CREATE TABLE shop_videos (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_id        UUID REFERENCES app_users(user_id) ON DELETE SET NULL,
  tenant_id         UUID,
  title             TEXT,
  caption           TEXT,
  video_url         TEXT NOT NULL,
  poster_url        TEXT,
  thumbnail_url     TEXT,
  duration_ms       INT NOT NULL DEFAULT 0,
  aspect_ratio      TEXT NOT NULL DEFAULT '9:16',
  status            TEXT NOT NULL DEFAULT 'draft'   CHECK (status IN ('draft','processing','active','paused','removed')),
  moderation_status TEXT NOT NULL DEFAULT 'pending' CHECK (moderation_status IN ('pending','approved','rejected')),
  is_curated        BOOLEAN NOT NULL DEFAULT TRUE,
  rank_score        NUMERIC NOT NULL DEFAULT 0,
  metadata          JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
```
**Auth model:** RLS on. `authenticated` SELECTs live (active+approved) rows only; `service_role` full access (curated seeding + studio in V1.1).

### shop_video_anchors
**Purpose:** Binds a `products` row to a `shop_video`. V1 ships a single PRIMARY anchor (the tappable pill) per video — enforced by the partial unique index `shop_video_anchors_one_primary`.

**Schema:**
```sql
CREATE TABLE shop_video_anchors (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  video_id          UUID NOT NULL REFERENCES shop_videos(id) ON DELETE CASCADE,
  product_id        UUID NOT NULL REFERENCES products(id),
  is_primary        BOOLEAN NOT NULL DEFAULT TRUE,
  label             TEXT NOT NULL DEFAULT 'Shop now',
  badge_price_cents INT,
  currency          CHAR(3),
  appear_at_ms      INT NOT NULL DEFAULT 0,
  pos_x             NUMERIC NOT NULL DEFAULT 0.5,
  pos_y             NUMERIC NOT NULL DEFAULT 0.82,
  metadata          JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX shop_video_anchors_one_primary ON shop_video_anchors (video_id) WHERE is_primary = TRUE;
```
**Auth model:** RLS on. `authenticated` SELECTs anchors of live videos; `service_role` full access.

### shop_saved_products
**Purpose:** Per-user product saves (wishlist) from the drawer; `video_id` records the source video for attribution. Owner-scoped via RLS.

**Schema:**
```sql
CREATE TABLE shop_saved_products (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES app_users(user_id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES products(id),
  video_id   UUID REFERENCES shop_videos(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, product_id)
);
```

### shop_video_events
**Purpose:** Video Shop view/commerce funnel sink. **DELIBERATELY SEPARATE from `oasis_events`** (CLAUDE.md §6: `telemetry.*` never to OASIS). Written by the gateway via `service_role`. Repointable to ClickHouse/BigQuery later without changing the API contract.

**Schema:**
```sql
CREATE TABLE shop_video_events (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  video_id    UUID NOT NULL REFERENCES shop_videos(id) ON DELETE CASCADE,
  anchor_id   UUID,
  user_id     UUID,
  session_id  TEXT NOT NULL,
  event_type  TEXT NOT NULL CHECK (event_type IN (
                'impression','hold_2s','anchor_tap','drawer_open','drawer_expand','pdp_view',
                'variant_change','add_to_cart','buy_now','checkout_start','purchase',
                'save','unsave','share','drawer_close')),
  product_id  UUID REFERENCES products(id) ON DELETE SET NULL,
  dwell_ms    INT,
  metadata    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
```
**Auth model:** RLS on, **no** `authenticated` policy → `service_role`-only (ingestion + analytics).

### Attribution thread (additive columns on existing tables)
- `universal_cart_items.source_video_id` (FK `shop_videos`, SET NULL) + `source_creator_id` (FK `app_users`, SET NULL).
- `product_orders.source_video_id` + `source_creator_id` — attribution snapshot copied at order time by the future checkout bridge (V1.2 payout basis); affiliate-postback orders leave them NULL.
- `universal_cart_items.source_surface` CHECK widened to admit `'video_shop'` (kept in sync with `ALLOWED_SOURCE_SURFACES` in `universal-cart.ts`).

**API Endpoints (mounted at `/api/v1/shop-feed`, community-role-gated):**
- `GET /videos`, `GET /videos/:id`, `GET /videos/:id/anchor`
- `POST /videos/:id/events`, `POST /events/batch`
- `GET /saved`, `POST /saved`, `DELETE /saved/:productId`

---

## Training Cycle Tracker (BOOTSTRAP-35DAY-TRACKER)

Backs the "Training" section on the Command Hub System Overview page
(`/command-hub/overview/system-overview/`). Generic across cycles — 35-day now,
30/60/90-day later. Read via `GET /api/v1/training/status` (gateway service role;
endpoint falls back to an embedded bootstrap snapshot if these tables are absent).

```sql
training_cycles (
  id UUID PK, label TEXT, length_days INT, start_date DATE,
  status TEXT,                       -- active | completed | aborted
  training_job_id TEXT,              -- Vertex CustomJob id
  training_job_state TEXT,           -- last recorded job state
  training_job_updated_at TIMESTAMPTZ,
  notes TEXT, created_at, updated_at
);

training_cycle_days (
  id UUID PK, cycle_id UUID FK -> training_cycles(id) ON DELETE CASCADE,
  day_number INT, day_date DATE,
  goal TEXT,                         -- set each morning by the operator
  status TEXT,                       -- pending | running | success | failure | partial
  outcome TEXT, evidence TEXT,
  initiated JSONB,                   -- [{ label, status, detail }]
  set_by TEXT, created_at, updated_at,
  UNIQUE (cycle_id, day_number)
);
```

**Auth model:** RLS-on, `service_role` bypass; no anon/community access (ops table).

---

### journey_session_index_awards (BOOTSTRAP-GUIDED-JOURNEY-POPUP)

Idempotent ledger of Vitana Index points earned by **listening** to a Guided
Journey session (+2 per distinct topic). Summed and applied as an additive
overlay on the user-facing Vitana Index read (`fetchVitanaIndexSnapshot`) — it
is **never** written into `vitana_index_scores`, so stored daily health history
stays clean and the bonus is recompute-safe + trivially reversible.

```
journey_session_index_awards (
  user_id UUID, topic_id TEXT,
  points INT DEFAULT 2 CHECK (points >= 0),
  created_at TIMESTAMPTZ,
  PRIMARY KEY (user_id, topic_id)
);
```

**Auth model:** RLS-on, `service_role` bypass; no permissive policy (gateway only).

---

### journey_checklist_topics — session bound (BOOTSTRAP-FIRST-TIME-ONBOARDING)

The Guided Journey curriculum (VTID-03277) now spans **94 sessions / 254
topics**: migration `20260613003000` prepended four first-time onboarding
sessions (T251 `Starte deine Longevity-Reise`, T252 `Dein Plan`, T253 `Dein
erster Schritt`, T254 `Dein Fortschritt`) at sessions 1-4 and shifted the
existing 90 sessions to 5-94. The `session` CHECK is now `BETWEEN 1 AND 94`.
Existing `user_guided_journey_state.current_session` pointers (> 1) were
shifted +4 so they keep referencing the same content. The current published
snapshot was rewritten in place by the same migration.

---

### journey_checklist_translations (BOOTSTRAP-GUIDED-JOURNEY-POPUP)

Per-locale (`en`/`es`/`sr`) translations of the user-facing Guided Journey topic
content. The curriculum is authored in German (the source of truth lives in
`journey_checklist_topics` / the published snapshot); the gateway overlays these
rows onto the snapshot at read time, falling back to German for any missing
field. Produced by `scripts/journey/generate-checklist-translations.mjs`.

```
journey_checklist_translations (
  topic_id TEXT, locale TEXT CHECK (locale IN ('en','es','sr')),
  display_label TEXT, short_description TEXT,
  explanation_what_it_is TEXT, explanation_user_benefit TEXT,
  explanation_when_to_use TEXT, explanation_try_this TEXT,
  source_version_id UUID,            -- published version translated from
  updated_at TIMESTAMPTZ,
  PRIMARY KEY (topic_id, locale)
);
```

**Auth model:** RLS-on, `service_role` bypass; no permissive policy (gateway only).

---

## Product Analytics (BOOTSTRAP-PRODUCT-ANALYTICS)

Dedicated product/behavior analytics pipeline backing the `/admin/insights/*`
supervision screens in vitana-v1 (Assistant usage, journeys, features,
interests, friction). Deliberately separate from `oasis_events` — OASIS stays
an audit/system log; this absorbs high-volume clickstream. Ingested via
`POST /api/v1/analytics/events/batch`, read via
`GET /api/v1/admin/tenants/:tenantId/analytics/*` (gateway service role only).

### product_analytics_events

```
product_analytics_events (
  id UUID PK, event_id TEXT UNIQUE,  -- client-generated, idempotency key
  event_name TEXT, event_type TEXT,  -- journey|assistant|feature|interest|friction|performance|content
  tenant_id UUID, user_id_hash TEXT, -- SHA-256 of user id; never the raw id
  session_id TEXT, journey_id TEXT, conversation_id TEXT,
  screen_route TEXT, screen_id TEXT, feature_key TEXT,
  source TEXT,                       -- web|ios|android|gateway|assistant|orb
  app_version TEXT, language TEXT,
  device_type TEXT,                  -- desktop|mobile|tablet|unknown
  consent_state TEXT,                -- granted|anonymous|denied (denied = dropped pre-insert)
  properties JSONB,                  -- metadata only — NEVER raw message text/prompts/transcripts
  occurred_at TIMESTAMPTZ, received_at TIMESTAMPTZ, created_at TIMESTAMPTZ
);
```

Retention: 180 days, purged by the gateway daily rollup job.

### product_analytics_daily_rollups

```
product_analytics_daily_rollups (
  id UUID PK, tenant_id UUID, rollup_date DATE,
  metric_key TEXT,                   -- e.g. active_users, sessions, feature_opens
  dimensions JSONB,                  -- e.g. { "feature_key": "community" }
  metric_value NUMERIC,
  created_at, updated_at,
  UNIQUE (tenant_id, rollup_date, metric_key, dimensions)
);
```

Retention: 2 years. Upsert on the unique key keeps the rollup job idempotent.

**Auth model:** RLS-on, `service_role` bypass; no anon/community access
(gateway only).

---

## VTID-02779 — Voice Clock (alarms / timers / pomodoro)

### voice_clock_items

```
voice_clock_items (
  id UUID PK, tenant_id UUID, user_id UUID NOT NULL,
  kind TEXT NOT NULL CHECK (alarm|timer|pomodoro),
  label TEXT,
  fires_at TIMESTAMPTZ,               -- absolute UTC instant the item rings
  recurrence TEXT,                    -- daily|weekdays|NULL (alarms only)
  duration_seconds INT,               -- timers/pomodoros only
  status TEXT NOT NULL DEFAULT 'active' CHECK (active|fired|cancelled|completed),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

Written by the ORB voice tools `set_alarm` / `start_timer` / `start_pomodoro`
(services/gateway/src/services/orb-tools/reminders-clock-tools.ts).
RLS-on with an owner policy (`auth.uid() = user_id`) + service-role bypass.
Indexes: `(user_id, status)` for list/delete; partial index on `fires_at`
WHERE `status='active'` for the future tick job.

**Follow-up needed:** FIRING (push/chime delivery when `fires_at` passes) is
not yet implemented — a cron/tick job analogous to `/reminders-tick` must be
added to claim due rows and transition `active → fired`.

---

## VTID-02950 — Recommend & Earn (Business tab)

Backs the owner's private "Business" segment (click/conversion/commission
stats, `discover-recommendations.ts`) and, as of
BOOTSTRAP-PUBLIC-BUSINESS-PROFILE, a public read-only storefront view for
profile visitors (`discover-recommendations-public.ts`) — same table, two
response shapes: the public endpoint drops all stats/earnings columns.
**Migration:** `supabase/migrations/20260715120000_vtid_02950_recommendation_commissions.sql`

### product_recommendations

**Purpose:** One row per (user, product) a community member has recommended
from Discover. Tracks clicks/conversions/commission earned for the owner's
private dashboard; only `status='active'` rows are exposed to other users.

```sql
CREATE TABLE product_recommendations (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                UUID,
  user_id                  UUID NOT NULL,
  product_id               UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  merchant_id              UUID REFERENCES merchants(id) ON DELETE SET NULL,
  sharing_link_id          UUID REFERENCES sharing_links(id) ON DELETE SET NULL,
  status                   TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  click_count              INT NOT NULL DEFAULT 0,
  conversion_count         INT NOT NULL DEFAULT 0,
  commission_earned_minor  BIGINT NOT NULL DEFAULT 0,
  commission_currency      CHAR(3) NOT NULL DEFAULT 'EUR',
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, product_id)
);
```

**Auth model:** RLS on, owner-select-only (`auth.uid() = user_id`) +
service-role full access. **All gateway routes use the service-role client,
bypassing RLS** — the route code's response-shaping (dropping stats fields
for the public endpoint) is the actual privacy boundary, not RLS.

---

## Feature Announcement News Feed Cards (BOOTSTRAP-FEATURE-ANNOUNCEMENTS)

Backs the "Brand New Feature" / "Did You Know" News Feed cards
(vitana-v1 `src/components/home/FeatureAnnouncementCard.tsx`). One row = one
admin-published announcement, shown to every member of its tenant until
deactivated. Written only via the gateway's admin-only endpoint
(`services/gateway/src/routes/admin-feature-announcements.ts`, mounted at
`/api/v1/admin/feature-announcements`), which also fans out an
in-app + push `feature_announcement` notification to every tenant member in
their own locale.

### feature_announcements

```sql
CREATE TABLE feature_announcements (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID NOT NULL,
  variant        TEXT NOT NULL CHECK (variant IN ('brand-new-feature', 'did-you-know-feature')),
  feature_title  JSONB NOT NULL,  -- { "en": "...", "de": "..." }
  description    JSONB NOT NULL,  -- { "en": "...", "de": "..." }
  deep_link      TEXT NOT NULL,
  is_active      BOOLEAN NOT NULL DEFAULT TRUE,
  target_user_ids UUID[],  -- NULL = whole tenant; set = staged test send to specific users
  created_by     TEXT,
  notified_at    TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

**Auth model:** RLS on. `SELECT` for any authenticated user whose
`user_tenants` row matches `tenant_id` AND (`target_user_ids IS NULL` OR
`auth.uid() = ANY(target_user_ids)`), AND `is_active = true`; `ALL` for
`service_role` (mirrors `ai_provider_policies`). Frontend reads it directly
via the Supabase client (same pattern as `profile_posts`/`media_uploads` in
`useAllNewsFeed.ts`) — no gateway GET route needed for the card itself.

### did_you_know_state

```sql
CREATE TABLE did_you_know_state (
  tenant_id   UUID PRIMARY KEY,
  last_index  INTEGER NOT NULL DEFAULT -1,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

One row per tenant, tracking the index of the last `did-you-know-feature`
tip published (from `services/gateway/src/data/feature-tips.ts`'s curated
list) by `POST /api/v1/scheduled-notifications/daily-feature-tip`
(BOOTSTRAP-DAILY-FEATURE-TIP, daily Cloud Scheduler job). Lets the rotation
advance one tip per day without repeating back-to-back, wrapping to 0 once
the list is exhausted.

**Auth model:** RLS on, `ALL` for `service_role` only — internal cron
state, never read by clients.

### watcher_steps

```sql
CREATE TABLE watcher_steps (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  work_unit_kind TEXT NOT NULL,  -- vtid | execution | pr | session
  work_unit_id   TEXT NOT NULL,
  vtid           TEXT,           -- denormalized; NULL for ungoverned work
  step           TEXT NOT NULL,  -- allocated|planned|queued|running|validated|pr_opened|ci|merged|deploying|verified|completed|failed|reverted|escalated|doc_updated|terminalized
  outcome        TEXT NOT NULL DEFAULT 'unknown',  -- success | failure | skipped | unknown
  actor          TEXT NOT NULL,  -- autopilot | worker-runner | claude-session | human | ci | unknown
  evidence       JSONB NOT NULL DEFAULT '{}'::jsonb,
  source         TEXT NOT NULL,  -- oasis_events | dev_autopilot_executions | session_api
  source_ref     TEXT NOT NULL,
  observed_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (source, source_ref, step)
);
```

**VTID-03460 (Watcher Phase 1)** — normalized development-lifecycle timeline.
Plan: `docs/WATCHER-AGENT-PLAN.md` (VTID-03454). One row per observed step,
written by `services/gateway/src/services/watcher/watcher-observer.ts`.

The `UNIQUE (source, source_ref, step)` constraint is load-bearing, not
cosmetic: the observer deliberately rescans a 5-minute overlap window behind
its cursor every tick (rows can commit with a `created_at` slightly behind
one already read, and a strict `> cursor` scan would step over them and lose
the step forever). The constraint is what makes that replay free — upserts
use `ignoreDuplicates`, so a re-read is a no-op rather than a duplicate.

**The observer emits ZERO OASIS events.** Its scan is a poll, and CLAUDE.md
§6 is explicit that polling ≠ progress. Only Phase 3's "a reminder was
raised" is a decision worth an event.

**Sources:** `oasis_events` (allowlisted development topics only — see
`services/gateway/src/services/watcher/normalizers.ts` for why an allowlist
and not a prefix match), `dev_autopilot_executions` (status anchor/backstop),
and `session_api` (push ingestion from Claude Code sessions).

**Auth model:** RLS on, no policies — service_role only, same posture as
`dev_autopilot_prompt_learnings`. Read via admin-gated
`GET /api/v1/watcher/timeline`.

### watcher_observer_state

```sql
CREATE TABLE watcher_observer_state (
  source       TEXT PRIMARY KEY,
  cursor_at    TIMESTAMPTZ NOT NULL,
  last_run_at  TIMESTAMPTZ,
  last_error   TEXT,
  last_written INTEGER NOT NULL DEFAULT 0,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

**VTID-03460** — one row per observer source, holding its scan cursor.
`last_error` and `last_written` exist so a degraded observer is *visible*
rather than silent (CLAUDE.md ALWAYS rule 10): a source that scans rows
every tick but writes zero is the signature of a broken normalizer, and
`GET /api/v1/watcher/health` surfaces exactly that.

**Auth model:** RLS on, service_role only.

### watcher_lessons

```sql
CREATE TABLE watcher_lessons (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  stage             TEXT NOT NULL,  -- planning|execute|validate|ci|merge|deploy|verify|any
  pattern_type      TEXT NOT NULL,  -- tsc_error|jest_failure|parse_error|out_of_scope|validation_other|ci_failure|deploy_failure|verification_failure|governance_violation|review_rejection
  pattern_key       TEXT NOT NULL,  -- normalized signature, e.g. TS2307:cannot-find-module
  scope             JSONB NOT NULL DEFAULT '{}'::jsonb,  -- {scanner?,service?,repo?,path_glob?}
  lesson            TEXT NOT NULL,  -- the imperative text that gets injected
  example_message   TEXT,
  mitigation_note   TEXT,           -- human-authored upgrade; preferred over `lesson`
  evidence_step_ids UUID[] NOT NULL DEFAULT '{}',
  source_finding_id UUID,
  source_execution_id UUID,
  frequency         INTEGER NOT NULL DEFAULT 1,
  confidence        REAL NOT NULL DEFAULT 0.5,
  status            TEXT NOT NULL DEFAULT 'active',  -- active|muted|graduated
  first_seen_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (stage, pattern_type, pattern_key)
);
```

**VTID-03461 (Watcher Phase 2)** — learned engineering memory, distilled from
`watcher_steps` failures. Plan: `docs/WATCHER-AGENT-PLAN.md`.

⚠️ **This table SUPERSEDES `dev_autopilot_prompt_learnings`, which its
migration DROPS.** The old rows are migrated in first (as `stage='execute'`,
`scope={scanner}`). Two learning stores feeding the same prompts is how they
drift apart — one gets written, the other gets read, and nobody notices.

Two things the old table could not do, and the reason for the new shape:
- **`stage`** — every old row was implicitly execute-time, so nothing learned
  at CI/deploy/verify had anywhere to live.
- **`scope` jsonb** (replacing a flat `scanner` column) — the worker-runner
  has no scanner, so it was structurally unable to read the old table at all.

Read/written via `services/gateway/src/services/watcher/lessons-store.ts`
(plus the repointed `dev-autopilot-planning.ts` / `dev-autopilot-execute.ts`
call sites). **Every read is best-effort and returns `[]` on error** — the
migration's deploy-order safety argument depends on that; if a lessons read
ever becomes fatal, a deploy window where the table is momentarily absent
would take planning and execution down with it.

**Auth model:** RLS on, no policies — service_role only.

### watcher_rules

```sql
CREATE TABLE watcher_rules (
  rule_key    TEXT PRIMARY KEY,
  source_ref  TEXT NOT NULL,   -- e.g. 'CLAUDE.md §16' — so a reminder can cite authority
  stage       TEXT NOT NULL,
  trigger     JSONB NOT NULL DEFAULT '{}'::jsonb,  -- {steps[],touches[],services[],actors[]}
  reminder    TEXT NOT NULL,
  severity    TEXT NOT NULL DEFAULT 'warn',  -- info|warn|block_candidate
  enabled     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

**VTID-03461** — AUTHORED governance invariants, seeded from `CLAUDE.md`
(~25 rules). Kept separate from `watcher_lessons` on purpose: a learned lesson
with `frequency=1` is a guess, while "never dispatch EXEC-DEPLOY to prod
post-cutover" is canon. They rank differently and age differently — rules are
never auto-derived and never auto-muted.

`severity='block_candidate'` does **not** block in v1. It marks a rule as a
candidate should gating ever be enabled; a blocking watcher that is wrong once
gets disabled forever.

Adding a rule is an INSERT, not a code change (the seed migration uses
`ON CONFLICT (rule_key) DO UPDATE`, so re-running is idempotent and a later
migration can correct a rule's text).

**Auth model:** RLS on, no policies — service_role only.

### dev_autopilot_prompt_learnings — ❌ DROPPED (VTID-03461)

Migrated into `watcher_lessons` and dropped by
`supabase/migrations/20260731180000_VTID_03461_watcher_lessons_rules.sql`.
Do not reference it. See `watcher_lessons` above.

### watcher_reminder_feedback

```sql
CREATE TABLE watcher_reminder_feedback (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reminder_id      TEXT NOT NULL,   -- 'rule:<rule_key>' | 'lesson:<uuid>'
  kind             TEXT NOT NULL,   -- rule | lesson
  work_unit_id     TEXT,
  vtid             TEXT,
  stage            TEXT,
  outcome          TEXT NOT NULL,   -- success | failure | unknown
  repeated_mistake BOOLEAN NOT NULL DEFAULT FALSE,
  note             TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

**VTID-03462 (Watcher Phase 3)** — the relevance signal that keeps
`watcher_lessons` from becoming noise. Without it the lesson store only ever
grows, the injected block fills with things that never mattered, and the
worker learns to skim past it — at which point the tokens are still spent and
the one reminder that would have helped is lost in the pile.

`reminder_id` is deliberately **not** a foreign key: a lesson can be deleted
or a rule renamed, and losing the historical feedback would erase the evidence
for why something was muted.

Phase 3 also adds three counters to `watcher_lessons`: `shown_count`,
`helped_count`, `ignored_count`. `shown_count` is the denominator auto-mute
needs — without it, "never helped" and "never actually injected" look
identical, and a lesson would be muted for never having had the chance.

**Rules are never auto-muted.** "Nobody violated this rule recently" is
evidence the rule is working, not evidence it should be retired. Only learned
lessons decay.

**Auth model:** RLS on, no policies — service_role only.

---

## Direct Messages — `chat_messages` + `get_recent_conversations()` (VTID-03493)

Direct (1:1) messages live in **`chat_messages`**, keyed by
`sender_id`/`receiver_id` — there is no thread row for a DM. The inbox is
derived by collapsing those messages to one entry per peer.

`get_recent_conversations(p_user_id, p_tenant_id, p_limit)` does that
collapse server-side. It returns one row per peer — the newest message of
each conversation — plus a computed `peer_id`, ordered **newest
conversation first**.

**The trap this function was built on.** `DISTINCT ON` requires the query's
`ORDER BY` to lead with the distinct key. The original body therefore ended
with `ORDER BY peer_id, created_at DESC` and applied `LIMIT p_limit` to
*that* — meaning "the N most recent conversations" was really "N
conversations sorted by a random UUID". With the gateway passing 50, a
member with 199 conversations got an arbitrary 50, of which only 7 of their
20 most-recently-active chats survived. Users experienced this as their chat
history disappearing.

If you ever edit this function, **keep the outer query**: the `DISTINCT ON`
pass picks the newest message per peer, and a wrapping `SELECT … ORDER BY
created_at DESC LIMIT p_limit` does the recency selection. Collapsing those
two back into one statement silently reintroduces the bug — the function
still returns rows, still looks correct in isolation, and only misbehaves
once a user has more conversations than the limit.

Related caps to keep in sync:

| Surface | Limit | Notes |
|---|---|---|
| `GET /conversations` (gateway) | `?limit`, default **250**, max 500 | Inbox list |
| `GET /conversation/:peerId` (gateway) | `?limit` default 50, max 100, `?before` ISO cursor | One page of thread history; `before` drives scrollback |

---

## Commerce Mesh — Connector Factory tables (VTID-03535, 2026-08-08)

**APPLIED to Supabase 2026-08-09 (VTID-03544, BLK-001 resolution)** — all 8
tables live with RLS enabled (no policies → service_role only).

Additive Prisma migration `prisma/migrations/20260808_vcaop_mesh_factory_0001/`
(reversible; `down.sql` verified up→down→up on ephemeral Postgres 16).
**NOT yet applied to any live database** — application is gated on the VCAOP
dev environment (vcaop BLK-001) and must follow the working migration paths
(VTID-03486/03492 lessons: verify the tables exist after applying; a green
workflow is not evidence).

| Table | Purpose |
|-------|---------|
| `partner_tenant` | A business connected (or connecting) to the Mesh; carries connection state |
| `integration_manifest` | One connector per (partner, connector_id); points at the policy-engine provider row that gates every call |
| `integration_version` | Immutable manifest versions (full JSON document + hash; secret REFERENCES only, never values) |
| `partner_capability` | Declared read/action/event capabilities per manifest |
| `schema_source` | Extracted partner schemas (fields + hash — the drift-detection anchor) |
| `schema_mapping` | Versioned partner-field → canonical-field mappings with confidence + `sensitive` flag |
| `mapping_decision` | Human approve/reject decisions on mappings (`decided_by` is a human reviewer id, never an AI identity) |
| `connector_certification` | Certification runs: contract-test results, pending mappings, outcome |

---

## Commerce Mesh — Durable workflow tables (VTID-03537, 2026-08-08)

**APPLIED to Supabase 2026-08-09 (VTID-03544)** — all 7 tables live with RLS
enabled (no policies → service_role only).

Additive Prisma migration `prisma/migrations/20260808_vcaop_mesh_workflows_0002/`
(reversible; verified up→down→up + FK cascade + idempotency-key uniqueness on
ephemeral Postgres 16). **NOT yet applied to any live database** — same gating
as the factory tables above (vcaop BLK-001, VTID-03486 drift discipline).

| Table | Purpose |
|-------|---------|
| `event_subscription` | Routes (tenant, connector, event_key) → workflow |
| `normalized_event` | Canonicalized partner events; id is a deterministic content hash — the idempotent-consumption anchor; only mapped fields stored |
| `workflow_definition` | Workflow identity |
| `workflow_version` | Versioned declarative step metadata |
| `workflow_run` | Durable run state; `idempotency_key` UNIQUE — the idempotent-command anchor; `(status, updated_at)` indexed for the stuck-run reconciler |
| `workflow_step` | Per-step outcome (completed/failed/compensated/compensation_failed), attempts, result |
| `dead_letter_event` | Dead-lettered events/runs with replay tracking |

---

## Commerce Mesh — settlement + consent/health tables (VTID-03540 / VTID-03541, 2026-08-08)

Two additive reversible migrations, both verified up→down→up on ephemeral
Postgres 16; **neither applied to any live database** (BLK-001 + the gates
below).

`20260808_vcaop_mesh_settlement_0003` — **APPLIED to Supabase 2026-08-09
(VTID-03544), RLS enabled** (VTID-03540 — sandbox instruments only
until the BLK-010 legal/regulatory review):

| Table | Purpose |
|-------|---------|
| `settlement_instruction` | VTNA settlement instructions; id is caller-supplied — the idempotency anchor; amounts computed by the deterministic ledger, never by an LLM |
| `connector_usage_record` | Per-tenant/connector usage metering (tool calls, outcomes, latency) |

`20260808_vcaop_mesh_health_0004` — **APPLIED to Supabase 2026-08-09
(VTID-03547) after the BLK-009 independent privacy review cycle** (round 1
FAIL → 14 findings remediated → re-review PASS with required changes →
N1–N5 fixed). As applied and verified live: RLS **with FORCE** on all four
tables (owner bound too, zero policies → service_role only), and
`consent_receipt` is append-only **by trigger**
(`trg_consent_receipt_immutable` raises on UPDATE/DELETE, for every role).
Attestations store a coarse `confidence_band` (low/medium/high), never the
exact ratio, and issuance is unique per (grant_id, claim, period). Never
join these tables into general query paths. The runtime layer additionally
refuses to construct without a recorded BLK-009 activation
(`assertHealthActivation`, services/vcaop/src/health/consent.ts):

| Table | Purpose |
|-------|---------|
| `consent_grant` | Purpose-bound grants (one grantee, one purpose, explicit claims, validity window, reward, retention/revocation status) |
| `consent_receipt` | Append-only receipts (granted/revoked/attestation_issued/access_denied) — FK is RESTRICT so history survives its grant; detail is metadata only, never metric values |
| `health_data_attestation` | Derived claims only (met/confidence); `raw_data_disclosed` defaults false; `deleted_at` marks the revocation cascade |
| `insurance_quote` | Insurer quotes citing attestations under a grant |

---

**Remember:** This file is the SINGLE SOURCE OF TRUTH for table names.
When in doubt, CHECK HERE FIRST!


## BackOffice — `erp_capability_grants` (VTID-03834, 2026-09-13) — applied to the live project 2026-09-14 (owner: "apply now")

The Vitana role `backoffice` (VTID-03832) opens `/backoffice`; an ERP **capability** gates what a
person may do inside (catalog: `services/gateway/src/constants/erp-capabilities.ts`, derived from
`docs/backoffice/GOLDEN-WORKFLOWS.md` §3). Role defaults are computed in the gateway; this table
holds only **explicit** grants and is written exclusively by the gateway's service role through
`POST /api/v1/backoffice/access/grant|revoke`.

### erp_capability_grants

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | `gen_random_uuid()` |
| `user_id` | UUID NOT NULL | grantee |
| `tenant_id` | UUID NOT NULL | tenant scope — grants never cross tenants |
| `capability` | TEXT NOT NULL | `<domain>.<level>`, CHECK on shape; real catalog validated in the gateway |
| `granted_by` | UUID | caller of the grant endpoint |
| `granted_at` | TIMESTAMPTZ | default `now()` |

Constraints: `UNIQUE (user_id, tenant_id, capability)`; indexes on `(user_id, tenant_id)` and `(tenant_id)`.
RLS: `authenticated` may SELECT own rows; `service_role` ALL. `hr.*` / `payroll.*` rows can only be
created by a tenant `admin` or an Exafy super-admin (enforced in the gateway, never a role default).

## role_preferences — the frontend role switcher's write target (VTID-03832 / VTID-03916)

Not previously documented here — the table (and `set_role_preference()`/
`get_my_permitted_roles()`/`validate_role_assignment()`/`me_set_active_role()`)
existed only in the live database before VTID-03832's
`20260913000002_vtid_03832_role_functions.sql` gave them a migration file.

**VTID-03995 (`20260917100000_vtid_03995_role_switch_community_and_membership_roles.sql`,
applied 2026-09-17):** `get_my_permitted_roles()` now returns
`user_permitted_roles` ∪ the caller's ACTIVE `memberships.role` for the tenant
∪ `'community'` (ladder-ordered; exafy admins still get all eight), and
`set_role_preference()` accepts `'community'` unconditionally and any role held
via an active `memberships` row without the `validate_role_assignment()`
grant-to-others check (the admin-is-exafy-only block, the upsert and the
`audit_events` insert are unchanged). Reason: `trg_activate_patient_profile`
(VTID-03932) bumps `memberships.role` community→patient and never writes
`user_permitted_roles`, so an automatically activated patient could neither
see Patient in the switcher nor switch back to Community. Frontend companion:
`exafyltd/vitana-v1` VTID-03993 (mobile role switcher).

| Column | Type | Notes |
|---|---|---|
| `user_id`, `tenant_id` | UUID | PK pair (`ON CONFLICT (user_id, tenant_id) DO UPDATE`) |
| `role` | **TEXT**, not an enum | independent `role_preferences_role_check` CHECK constraint — does **not** inherit from `tenant_role`/`vitana_role` |
| `updated_at` | TIMESTAMPTZ | |

**VTID-03832 extended the `tenant_role`/`vitana_role` enums (and the four role
RPCs) to the 8-role ladder but never touched this CHECK constraint** — it was
still `role = ANY (ARRAY['community','patient','professional','staff','admin'])`.
`set_role_preference()`'s `INSERT` therefore raised a `23514` violation for
`backoffice`/`developer`/`infra` unconditionally, regardless of the caller's
permission (an exafy_admin, who bypasses every permission check in that
function, still hit this). **VTID-03916 widened it** to
`community, patient, professional, staff, backoffice, admin, developer, infra`
— applied directly to the live project 2026-09-15, migration file
`20260915131400_vtid_03916_widen_role_preferences_check.sql`.

**Known sibling gap, NOT fixed by VTID-03916 (flagged, deliberately deferred):**
`nav_catalog_role_chk` has the identical shape of bug — it carries
`admin`/`developer`/`infra` but is still missing `backoffice`. VTID-03832's own
changelog entry already lists "nav-catalog rows for the BackOffice Navigator
role" as an open decision, so this is a known gap, not a currently-firing bug
(nothing inserts a `backoffice` nav_catalog row yet). A separate, much older
`user_active_role` (singular) table has an even narrower CHECK
(`community`/`developer`/`admin` only) — confirmed dead: no code path in
either repo writes to it (`me_set_active_role()` writes the different,
unconstrained `user_active_roles` plural table, and nothing on the frontend
calls that RPC either).

## BackOffice — command orchestrator tables (VTID-03842, 2026-09-13) — applied to the live project 2026-09-14 (owner: "apply now"); browser-role privileges revoked by `20260914130000_vtid_03842_erp_tables_revoke_browser_roles.sql`

`supabase/migrations/20260913020000_vtid_03842_erp_commands_approvals_audit.sql`. Written only by the gateway (service role) behind `POST /api/v1/backoffice/commands` and the approvals routes; the browser never touches them.

### erp_commands
| Column | Type | Notes |
|---|---|---|
| id | UUID PK | command_id returned to the client |
| tenant_id, requester_id | UUID | tenant from `me_context`, requester = caller |
| channel | TEXT | web / chat / voice / system |
| type, action | TEXT | typed command (`constants/backoffice-commands.ts`) and the ERPClaw action it maps to |
| tier | TEXT | read / draft / commit / high — AFTER §4.3 escalations |
| status | TEXT | executed / failed / awaiting_approval / rejected |
| payload, resolved_payload | JSONB | as sent; after exact-match entity resolution |
| idempotency_key, request_hash | TEXT | UNIQUE (tenant_id, idempotency_key); hash of type+payload for replay/conflict |
| reason, approval_id, receipt, escalations | | policy reason; queue link; bridge receipt; §4.3 attributes that escalated |

### erp_approvals
| Column | Type | Notes |
|---|---|---|
| id | UUID PK | approval_id |
| command_id | UUID FK → erp_commands | |
| requester_id, decided_by | UUID | CHECK decided_by <> requester_id (maker-checker at the storage layer) |
| approve_capability | TEXT | what the approver must hold (`finance.pay`, `finance.approve`, `accounting.close`, `payroll.approve`, `erp.admin`) |
| status | TEXT | pending / approved / rejected |
| reason, decision_note, decided_at | | `no_eligible_approver` when the tenant lacks a second approver |

### erp_audit_log (append-only)
| Column | Type | Notes |
|---|---|---|
| id, tenant_id, actor_id, actor_role, channel | | |
| event | TEXT | `command.executed` / `command.failed` / `command.queued` / `command.rejected` / `approval.approved` / `approval.rejected` / `policy.updated` |
| command_id, approval_id, details | | |
| — | trigger | `trg_erp_audit_log_immutable` raises on UPDATE/DELETE; UPDATE/DELETE also REVOKEd from service_role |

### erp_policy_settings
| Column | Type | Notes |
|---|---|---|
| tenant_id | UUID PK | |
| high_risk_amount_threshold | NUMERIC | default 25000 (AED) — §4.3 |
| require_mfa_for_high | BOOLEAN | default true — approvals need an `aal2` session |
| updated_by, updated_at | | |

---

## VTID-03894 — Maxina supplier self-service (multi-vertical catalog)

Suppliers span supplements, blood tests, gym equipment, textiles and wine, so
the catalog asks each vertical its own questions instead of hardcoding one
industry's columns. Written by the owner-scoped endpoints in
`services/gateway/src/routes/vcaop-portal-my-products.ts`.

### products.attributes (new column on an existing table)

```sql
ALTER TABLE products ADD COLUMN attributes JSONB NOT NULL DEFAULT '{}'::jsonb;
CREATE INDEX idx_products_attributes ON products USING GIN (attributes jsonb_path_ops);
```

Vertical-specific answers (a wine's vintage, a garment's fabric) live here,
keyed by `catalog_vertical_fields.field_key`.

**The existing health columns were deliberately NOT moved in here.**
`contains_allergens` and `contraindicated_with_conditions` /
`contraindicated_with_medications` are read by `user_limitations` as a **hard
filter** on who is shown a product. Moving them behind a JSONB round trip would
change that filter's behaviour — a correctness change wearing a refactor's
clothes. They stay typed columns.

### catalog_verticals

| Column | Type | Notes |
|---|---|---|
| key | TEXT PK | CHECK `^[a-z][a-z0-9_]{1,48}$` |
| display_label | TEXT NOT NULL | |
| description, icon | TEXT | |
| is_regulated | BOOLEAN | default false — diagnostics and supplements are |
| is_active, sort_order, created_at | | |

Ten seeded: `supplements`, `diagnostics`, `fitness_equipment`, `apparel`,
`wine_spirits`, `beauty_care`, `devices_wearables`, `home_living`, `services`,
`other`. Referenced by `merchants.vertical_key` and `catalog_vertical_fields`.

### catalog_vertical_fields

| Column | Type | Notes |
|---|---|---|
| id | UUID PK | |
| vertical_key | TEXT FK → catalog_verticals(key) ON DELETE CASCADE | |
| field_key | TEXT NOT NULL | CHECK `^[a-z][a-z0-9_]{1,48}$`; UNIQUE (vertical_key, field_key) |
| display_label, help_text | TEXT | |
| data_type | TEXT NOT NULL | CHECK in text / number / integer / boolean / date / enum / multi_enum / url |
| vocabulary | TEXT | names a `catalog_vocabulary` set |
| unit | TEXT | rendered as an input suffix (`%`, `g`, `ml`) |
| is_prominent | BOOLEAN | above the fold vs. behind "More details" |
| is_active, sort_order, created_at | | |
| — | CHECK | `catalog_vertical_fields_enum_needs_vocabulary`: a field whose `data_type` is `enum`/`multi_enum` MUST name a vocabulary — otherwise the form renders a select with no options and the supplier cannot answer a question it insists on asking |
| — | index | `idx_catalog_vertical_fields_lookup (vertical_key, sort_order) WHERE is_active` |

37 fields seeded. **`other` deliberately has none** — a catch-all that asks
questions is a catch-all nobody picks.

### catalog_vocabulary (CHECK widened)

The `vocabulary` CHECK previously enumerated six hardcoded health vocabularies,
so a wine region or a fabric could not be added without a migration. It is now
a shape regex on the vocabulary name. The six original values still validate.

### merchants (new columns)

| Column | Type | Notes |
|---|---|---|
| owner_user_id | UUID | the supplier who registered. **Every read and write in the portal resolves the merchant by this column from the JWT**, never from a client-supplied id |
| partner_tenant_id | UUID | set when the merchant arrived via a VCAOP connection |
| vertical_key | TEXT FK → catalog_verticals(key) | |
| onboarding_status | TEXT | default `draft`; CHECK in `draft` / `in_review` / `approved` / `rejected` / `suspended` |
| affiliate_advertiser_id | TEXT | the supplier's id **within** `affiliate_network`. Load-bearing: `creditAwinConversions` resolves a pulled conversion to a merchant by it, so a named network without this id records a preference and attributes nothing. Partial index where not null |

No CHECK was added to `affiliate_network` — the column predates this VTID and
already carries values written by catalog ingest.

### How a supplier row reaches checkout

`services/checkout/checkout-service.ts` routes every cart line by
`products.source_network`. Anything in its `FIRST_PARTY_SOURCE_NETWORKS`
(`manual`, `partner`) **debits the buyer's Vitana wallet** and writes a
CONVERTED order meaning "Vitana fulfils".

A supplier product is not that. It carries an `affiliate_url` to the supplier's
own shop, and nothing in this platform pays a supplier or tells them to ship.
Tagged `'manual'`, approving one would take a member's money for an order nobody
would ever fulfil.

### RLS on the two new catalog tables

Both carry the same posture as `catalog_vocabulary`: `authenticated` may SELECT
active rows, `service_role` may do anything, and there is no `anon` policy.

They shipped in `20260915100000` with **no RLS at all**, which in Supabase means
anon-key reach through PostgREST for reads *and writes* — the questions every
supplier is asked were briefly writable by anyone. The Supabase security advisor
(`rls_disabled_in_public`) is what caught it; `20260915132000` closes it. Run the
advisor after any migration that creates a table.

### Supplier rows are `source_network = 'supplier_referral'` — not `'manual'`

`SUPPLIER_SOURCE_NETWORK = 'supplier_referral'` is therefore kept outside that
set, and `services/gateway/test/routes/supplier-source-network.test.ts` pins
both the value and the set so widening it later fails loudly rather than
silently moving real money. Supplier rows are also written `is_active = false`
with `onboarding_status = 'draft'`; only an admin flips them.

## Health Brain — `lab_reports` (VTID-01078; RLS user-scoped VTID-04044, 2026-09-18) — APPLIED to the live project 2026-09-18

**Purpose:** one row per uploaded (or partner-projected) health report. Written
browser-direct by `exafyltd/vitana-v1`'s `HealthReportUploadSheet.tsx` after the
file lands in the private `health-reports` storage bucket (object key
`<user_id>/<report_type>/<ts>_<name>`, per-user storage policies), and by the
gateway's partner-health ingestion (`partner_result_id`, VTID-03885).

| Column | Type | Notes |
|---|---|---|
| `id`, `tenant_id`, `user_id`, `created_at` | | c1 base |
| `source` | TEXT | `'upload'` from the sheet |
| `report_date` | DATE | test date chosen in the sheet |
| `report_type` | `health_report_type` | `blood_panel, genomics, metabolomics, microbiome, allergy, cancer, hormones, imaging, other` |
| `title`, `provider_name`, `file_path`, `file_size`, `mime_type` | | upload metadata; `file_path` is the storage key both list surfaces open |
| `processing_status` | `health_processing_status` | `uploaded → processing → parsed / failed`; **nothing moves a user upload past `uploaded` today** (AP-0607's `health.lab_report.uploaded` event is never dispatched and there is no parser) |
| `raw_file_ref`, `raw_text`, `parsed_json`, `ai_summary` | | c1/legacy; unset for user uploads |
| `partner_result_id` | UUID | VTID-03885 provenance link |

**RLS (VTID-04044):** one user-scoped policy, `lab_reports_user_policy FOR ALL
USING/WITH CHECK (user_id = auth.uid())` — same shape as
`vitana_index_scores_user_policy` (20260423081500) and for the same reason:
the c1 policies gated on `tenant_id = current_tenant_id()`, which is NULL for
browser JWTs (the tenant lives at `app_metadata.active_tenant_id`; the
20260218 function fix was never applied live), so **no upload ever inserted a
row** — 22 orphaned bucket objects, 0 rows, `new row violates row-level
security policy` in the Postgres logs. Service-role writes bypass RLS as before.

**Trigger:** `trg_notify_lab_report` → `notify_on_lab_report_processed()`
("Lab Report Ready") now fires `AFTER UPDATE OF processing_status` when it
becomes `parsed`, not `AFTER INSERT` — on insert it announced results that do
not exist.


## Commerce Partner Onboarding — `partner_organizations` + roster (VTID-03932, 2026-09-15) — APPLIED (Phase A, VTID-03957, 2026-09-17)

Applied to the live project 2026-09-17 under VTID-03957 (all four tables, both
FK columns and `trg_partner_health_test_orders_activate_patient` confirmed via
`to_regclass`). The `commerce_vertical` column below was added by VTID-03974
(`20260916130000_vtid_03974_commerce_vertical.sql`) and applied 2026-09-17 on
the platform owner's instruction (VTID-03996 records the apply).

Phase 1 of the platform-owner-approved plan to let any business (medical or
non-medical) self-register once and have its own staff/professionals granted
access, rather than an engineer hand-seeding `partner_registry` per partner
(the VTID-03885 pattern DoctorBox shipped under). Deliberately a **separate,
parallel** concept from `tenants` (the small, fixed set of Vitana-operated
portal brands) — org-scoped roles below are NOT `vitana_role`/`tenant_role`
values.

### partner_organizations

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | |
| `org_key` | TEXT UNIQUE NOT NULL | slug |
| `display_name`, `org_type` | TEXT NOT NULL | `org_type` free-text by convention, mirrors `partner_registry.integration_mode`'s own pattern — no migration needed for a new vertical |
| `status` | TEXT | `pending_review` (default) `\| active \| suspended \| rejected` |
| `owner_user_id` | UUID NOT NULL | the registering caller |
| `business_details` | JSONB | |
| `partner_type` | TEXT CHECK (`lab` \| `supplier_shop` \| `practitioner_clinic` \| `service_provider` \| `affiliate_brand`), nullable | VTID-04471: enforced partner vocabulary (spec §5.1). When set, `trg_partner_organizations_sync` derives `commerce_vertical` from it (`lab`, `practitioner_clinic` → `health`; the rest → `general`). NULL for rows registered without it. |
| `lifecycle_state` | TEXT NOT NULL CHECK (`draft` \| `submitted` \| `verifying` \| `needs_action` \| `exception` \| `live` \| `paused` \| `suspended` \| `rejected`) | VTID-04471: onboarding lifecycle (spec §5.2). Allowed transitions live in the gateway (`services/partner-lifecycle.ts`). Kept in sync with `status` by `trg_partner_organizations_sync` in both directions: lifecycle → status via `partner_org_status_for_lifecycle()` (`live` → `active`; `paused`, `suspended` → `suspended`; `rejected` → `rejected`; all others → `pending_review`); a status-only write (legacy `/register`, `/activate`) derives the lifecycle. |
| `legal_name`, `vat_id`, `website` | TEXT, nullable | VTID-04471: company facts collected during onboarding. |
| `country` | TEXT CHECK `^[A-Z]{2}$`, nullable | VTID-04471: ISO 3166-1 alpha-2. |
| `trust_level` | SMALLINT NOT NULL DEFAULT 0 CHECK 0..2 | VTID-04471: computed by the onboarding engine (spec §7), never set from a request. |
| `commerce_vertical` | TEXT CHECK (`health` \| `general`), nullable | VTID-03974: machine-readable routing signal set explicitly at registration (`POST /api/v1/partner-orgs/register` requires it, never inferred from `org_type`). `health` orgs get a `partner_registry` row bridged on activation (`POST /:orgId/activate`, FK `partner_registry.partner_organization_id`); `general` orgs never touch `partner_registry`. NULL for rows registered before the column existed. |

**Links to the org (VTID-04471):** `merchants.partner_organization_id` (UUID FK,
`ON DELETE SET NULL`, nullable: network-sourced merchants have no owner) and
VCAOP `partner_tenant.partner_organization_id` (UUID FK, same; Prisma migration
`20260924_vcaop_partner_org_link_0007`). Both migrations backfill: every owned
merchant / connection without an org is linked to its owner's first org, or to a
new one-member `draft` org (owner = `org_admin`). Zero such rows existed on
2026-09-24.

### partner_onboarding_steps (VTID-04478)

| Column | Type | Notes |
|---|---|---|
| `partner_organization_id` | UUID FK → partner_organizations, ON DELETE CASCADE | PK part 1 |
| `step_key` | TEXT CHECK (`verification` \| `catalogue` \| `mapping` \| `tracking_test` \| `results_channel` \| `dpa` \| `billing_mandate`) | PK part 2. `account`, `company`, `terms` and `team` are derived by the gateway and never stored. |
| `status` | TEXT CHECK (`todo` \| `in_progress` \| `done` \| `failed` \| `not_required`) DEFAULT `todo` | |
| `detail` | JSONB | step-specific evidence (e.g. a failure reason) |
| `updated_by`, `created_at`, `updated_at` | | |

Written only by the gateway (service role); members read their own org's rows via `is_partner_org_member()` (RLS). Read by `services/partner-onboarding-checklist.ts`.

### partner_terms_acceptances (VTID-04478)

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | |
| `partner_organization_id` | UUID FK → partner_organizations, ON DELETE CASCADE | |
| `terms_version` | TEXT NOT NULL | `UNIQUE (partner_organization_id, terms_version)` |
| `accepted_by` | UUID NOT NULL | |
| `accepted_at` | TIMESTAMPTZ | |
| `ip_address`, `user_agent` | TEXT | audit (spec §6.2) |

Written only by `POST /api/v1/partner-onboarding/:orgId/terms/accept`; members read their own org's rows (RLS).

### partner_organization_members

| Column | Type | Notes |
|---|---|---|
| `partner_organization_id` | UUID FK → partner_organizations | |
| `user_id` | UUID NOT NULL | |
| `role` | TEXT CHECK | `org_admin \| staff \| professional` — a separate dimension from `vitana_role`, never that enum |
| `granted_by`, `granted_at` | | |

`UNIQUE (partner_organization_id, user_id)` — one role per org per user.

### partner_organization_invites

Email + token invite, `role` same CHECK as above, `expires_at`/`accepted_at`.
Redeeming the token inserts the `partner_organization_members` row — works
whether or not the invitee already has a Vitana account (auto-`community` on
signup is unchanged, per the existing `provision_platform_user()` trigger).

### patient_profiles

| Column | Type | Notes |
|---|---|---|
| `user_id` | UUID PK | |
| `activated_at` | TIMESTAMPTZ | |
| `activation_reason` | TEXT CHECK | `partner_order \| vitana_service` |

Vitana-wide, never org-scoped — set once, ever, by the new `AFTER INSERT`
trigger `trg_partner_health_test_orders_activate_patient` on
`partner_health_test_orders`, the first time a `user_id` gets any health
order regardless of which partner org. The same trigger best-effort bumps
`memberships.role` from `community`→`patient` (never downgrades
staff/admin/etc; wrapped in `EXCEPTION` so a live-schema mismatch in
`memberships` — whose exact shape here is inferred from `routes/auth.ts`'s
`GET /me` contract, not created by any migration in this repo — can never
block the order insert itself).

### Existing tables extended

- `partner_registry` (VTID-03885) gains a nullable `partner_organization_id`
  FK — set once a self-registered org needs the health-integration
  capabilities that table already models; hand-seeded partners (DoctorBox
  pre-VTID-03932) may have none.
- `partner_health_test_orders` (VTID-03885) gains
  `assigned_professional_user_id` — order-scoped least-privilege assignment;
  a professional acts on exactly the orders assigned to them, never a
  standing "see everything for this patient" grant. A persistent
  `care_relationships` table for an ongoing (non-order-scoped) relationship
  is an explicit, deferred v2, not built here.

### Access resolution (`services/partner-health/org-access.ts`)

Not a table — the runtime layer that lets `admin-partner-health.ts`'s
existing routes (VTID-03885) serve a partner org's own staff/professional
members, re-keyed from `tenant_id` to `partner_organization_id` on the same
shape as `erp-access.ts`'s `effectiveCapabilities()`. `org_admin`/`staff`
get full access to every `partner_registry` row linked to their org;
`professional` gets access only to orders where
`assigned_professional_user_id` matches them.

**Not applied to the live database — file only (rule 4).** No
Supabase/gateway credentials were reachable from this session; see
`docs/validation/VTID-03932/acceptance.md`.

---

## Memory — canonical stores, embeddings, health (VTID-04341 / 04342 / 04343 / 04345, 2026-09-23) — APPLIED to the live project

Plan and rationale: `docs/MEMORY-SYSTEM-PLAN.md`. Canonical user memory is two tables:

| Table | Holds | Embedding |
|---|---|---|
| `memory_facts` | Current key/value facts with provenance and supersession (`superseded_by IS NULL` = current). Written only through `write_fact()`. | `embedding vector(1024)`, `embedding_model = 'amazon.titan-embed-text-v2:0'` |
| `memory_items` | Episodes (conversation turns today; session summaries, diary, daily learnings in later phases). | `embedding vector(1024)`, same model |

- **`write_fact(...)`** — if the current fact for (tenant, user, entity, fact_key) has the same value (trimmed, case-insensitive) and the incoming provenance is not stronger, returns the existing id and writes nothing. Strength: `user_*` 3 > `system_observed` 2 > `assistant_inferred` 1 > other 0. A different value, or a stronger source confirming the same value, supersedes as before.
- **Embeddings** are written by the gateway only (`services/gateway/src/services/memory-embedding.ts`): on write (`memory_items`, fire-and-forget), async after `write_fact` (facts), and by the hourly AP-0910 backfill for anything left NULL. No fallback provider — a vector from another model is never written into these columns.
- **Search RPCs** `memory_semantic_search(vector, …)` and `memory_facts_semantic_search(vector, …)` take an untyped `vector` and compare with `<=>`; they need no change when the dimension changes.
- **Diary** — the broker reads both `diary_entries` (the app's Daily Diary; `user_id`, no tenant column) and `memory_diary_entries`, merged newest-first.
- **`ci_memory_health()`** — `SECURITY DEFINER`, `service_role` only, counts only: writes/24h, `preferred_language` writes/24h, embedding coverage of rows older than 2h, `dlq_new_24h`, `memory.orchestrator.context_built` with memory / with diary, AP-0910 last run. Read by `MORNING-SYSTEM-HEALTH-CHECK.yml` check 21.
- **One fact write path (VTID-04364):** every gateway fact write goes through `services/gateway/src/services/memory/remember.ts` (`rememberFact()`: Identity Lock → `write_fact` → async Titan embedding). A source-contract test fails the build if any other file calls `write_fact`.
- **Session summaries (VTID-04365):** every session end calls `commitSessionMemory()` once. It extracts facts, and for a session with ≥ 2 user turns and ≥ 200 chars writes one `memory_items` row: `category_key = 'session_summary'`, `source = 'system'`, `importance = 50` (kept ≤ 50 so `trg_notify_memory_garden` does not notify), `content_json = { kind, session_id, channel, user_turns, summary_provider }`, written by the `memory` routing stage. `uq_memory_items_session_summary` makes it one per (user, session); a losing concurrent insert gets 23505, which is treated as already committed.
- **Role scope (VTID-04367):** `memory_items.active_role` is NULL for personal memory (roles community / user / member / patient / none) and the role name otherwise (e.g. `developer`, `staff`, `backoffice`). Reads pass `p_active_role`; `memory_semantic_search` returns rows where `active_role IS NULL OR = p_active_role`, so personal memory is visible in every role and work-role memory only in its own role. The REST fallback uses the same filter.
- **`memory_transcript_turns` (VTID-04387):** `id, tenant_id, user_id, session_id, conversation_id, role ('user'|'assistant'), content, source, channel, active_role, occurred_at, created_at`. Every `memory_items` write whose `content_json.direction` is `user`/`assistant` is recorded here by the gateway. Recent-turn grounding and session transcript rebuilds read this table first. Rows older than 90 days are deleted nightly. Raw turns are still copied to `memory_items` until `MEMORY_RAW_TURNS_TO_ITEMS=false` is set (after session summaries are observed live).
- **Memory Garden (VTID-04388/04389):** `/api/v1/memory/garden/{entries,categories}` lists current `memory_facts` plus non-raw `memory_items`, grouped into the 13 Garden categories (facts by key, episodes via `memory_category_mapping`). User edits write facts with `provenance_source = 'user_stated_via_memory_garden_ui'` (supersedes) and notes as `memory_items` (`source 'upload'`, `kind 'garden_note'`). Forgetting a fact deletes every row of that key for the user, history included.
- **Diary (VTID-04390):** `POST /api/v1/memory/diary/entries` writes the `diary_entries` row, one `memory_items` episode (`source 'diary'`, `kind 'diary'`, `content_json.diary_entry_id`), and runs the health-feature / Vitana Index sync. Deleting or editing the episode in the Garden updates the diary row too.
- **Notification threshold:** `trg_notify_memory_garden` inserts a `memory_garden_grew` notification for every `memory_items` insert with `importance > 50`. Memory writers therefore keep automatic episodes at ≤ 50.
- Tier-2 mirrors `mem_facts` / `mem_episodes` / `mem_graph_edges` still exist, but the gateway no longer writes or reads `mem_facts` / `mem_episodes` (VTID-04366). The broker's SEMANTIC block reads current `memory_facts` (`superseded_at IS NULL`). The DB trigger `mirror_relationship_edge_to_tier2_trg` and the `mem_tier2_dual_write_enabled` flag are left in place until production runs this code (the published prod gateway still reads the mirrors); drop both, and the three tables, after two weeks of clean health checks.

**Superseded note (VTID-04337, 2026-09-23):** the VTID-03932 session
recorded this section as "not applied — file only", but it was applied on
2026-09-17 under VTID-03957 (see the heading above). The live tables are
currently empty (0 organizations, 0 members).

### RLS (VTID-04337, applied 2026-09-23)

The original VTID-03932 SELECT policy on `partner_organization_members`
queried `partner_organization_members` inside its own `USING` clause. Every
browser read failed with `42P17 infinite recursion detected in policy`, and
the `partner_organizations` policy re-entered it for any non-owner member.
Migration `20260923120000_vtid_04337_partner_org_members_rls_no_recursion.sql`
replaces both policies with calls to one helper:

- **`public.is_partner_org_member(p_org_id uuid) → boolean`**
  - `SECURITY DEFINER`, `SET search_path = public`, `STABLE`.
  - True if the **calling** user (`current_user_id()`) is a member of the org.
    There is no user-id parameter, so it cannot be used to probe other users.
  - Revoked from `PUBLIC`; granted to `anon`, `authenticated` and `service_role`.
    `anon` needs it because it holds SELECT on `partner_organizations`, and
    Postgres checks EXECUTE on a policy's functions even when an earlier OR
    branch is already true. For `anon` it always returns false.
- **`partner_organization_members_select`:**
  `is_partner_org_member(partner_organization_id)`.
- **`partner_organizations_select`:**
  `status = 'active' OR owner_user_id = current_user_id() OR is_partner_org_member(id)`.

Evidence: `docs/validation/VTID-04337/outputs/` (42P17 before; clean reads for
`authenticated` and `anon` after).
