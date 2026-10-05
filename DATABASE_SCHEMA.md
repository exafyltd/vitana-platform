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

**Insert gate (VTID-04868):** every new row passes the BEFORE INSERT trigger
`trg_plan_sparring_check` (Plan Sparring Gate, log mode — see
`plan_sparring_sessions` below). `metadata.sparring_id` is unique across rows
(partial index `vtid_ledger_sparring_id_unique`); after the hardening
migration `20261004120000` a sparring id binds only together with
`metadata.plan_hash` equal to the record's approved `final_plan_hash`.

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

### voice_session_facts / voice_session_facts_hourly — committed, NOT yet applied (VTID-04776)

One row per ORB voice session (SSE, WebSocket and LiveKit) — the per-session
fact behind the Command Hub Voice Supervisor (`/api/v1/voice/supervisor/*`).
Before it a session existed only as OASIS events with no tenant column, and the
start/stop events carried no role, surface, language or provider. Migration
`20261001120000_vtid_04776_voice_session_facts.sql` (additive, idempotent;
apply with `RUN-MIGRATION.yml`). Verified against a local Postgres 16: applies
twice cleanly, backfill idempotent, anon/authenticated refused.

```sql
CREATE TABLE voice_session_facts (
  session_id         TEXT PRIMARY KEY,      -- live-<uuid> (gateway) / orb-<uuid> (LiveKit)
  tenant_id          UUID NULL,
  user_id            UUID NULL,
  is_anonymous       BOOLEAN NOT NULL DEFAULT false,
  surface            TEXT NULL,             -- vitanaland | command-hub | admin | backoffice | commerce
  role               TEXT NULL,             -- role the Assistant Profile served
  persona_key        TEXT NULL,
  profile_resolution TEXT NULL,             -- declared | route | narrowed | unverified | anonymous
  lang               TEXT NULL,
  provider           TEXT NULL,             -- nova_sonic | cascade | vertex_serbian_bridge | livekit | unknown (CHECK)
  selection_reason   TEXT NULL,
  transport          TEXT NULL,             -- sse | ws | livekit (CHECK)
  is_mobile          BOOLEAN NULL,
  app_version        TEXT NULL,
  entry              TEXT NULL,
  started_at         TIMESTAMPTZ NOT NULL,
  ended_at           TIMESTAMPTZ NULL,
  last_activity_at   TIMESTAMPTZ NULL,      -- refreshed every 5 min while live
  duration_ms        INTEGER NULL,
  turn_count         INTEGER NULL,
  user_turns         INTEGER NULL,
  model_turns        INTEGER NULL,
  audio_in_chunks    INTEGER NULL,
  audio_out_chunks   INTEGER NULL,
  ttfa_ms            INTEGER NULL,          -- session start -> first model audio
  p50_turn_ms        INTEGER NULL,          -- reserved; not written yet
  close_reason       TEXT NULL,
  close_code         INTEGER NULL,          -- last upstream close code before the end
  failure_class      TEXT NULL,             -- voice-failure-taxonomy class, NULL when healthy
  outcome            TEXT NULL,             -- ok | silent | one_way | dropped | error | abandoned | active (CHECK)
  stall_count        INTEGER NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()   -- trigger-maintained
);
-- indexes: (started_at DESC), (tenant_id, started_at DESC), (surface, role, started_at DESC),
--          (provider, started_at DESC), (lang, started_at DESC), partial (started_at DESC) WHERE ended_at IS NULL
```

- Written only by the gateway (`services/gateway/src/services/voice-session-facts.ts`),
  fire-and-forget: start (session/start, LiveKit token mint), updates (provider
  selected, first audio, member role resolved, activity heartbeat, orb-agent
  start via `/api/v1/oasis/emit`), end (all five gateway stop paths, WS
  cleanup, orb-agent stop). Kill switch `VOICE_SESSION_FACTS_ENABLED=false`.
- `outcome` / `failure_class` come from `classifyVoiceSessionOutcome()` (reuses
  `classifyQualityFromSessionStop` / `detectAudioOneWay`).
- View `voice_session_facts_hourly` (`security_invoker`): per hour x tenant x
  surface x role x provider x lang — sessions, ok/silent/one_way/dropped/error
  counts, avg duration, p50/p95 ttfa (`percentile_cont`).
- Function `voice_session_facts_backfill(p_since timestamptz) RETURNS int`:
  best-effort rebuild from `oasis_events` (start/stop/profile.resolved/
  provider.selected joined on `metadata->>session_id`), `ON CONFLICT DO NOTHING`,
  `p_since` required and at most 30 days back. NOT run by the migration —
  operator step after apply.
- RLS on, no policies; `anon`/`authenticated` revoked on table and view;
  `service_role` only (table, view, function).

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

### founding_members — Founding 1000 (VTID-04859, 2026-10-03)

The first 1,000 members get a free Premium year (owner decision 2026-10-01,
`docs/business-model/BUSINESS-MODEL.md` §11).

```sql
CREATE TABLE public.founding_members (
  user_id        uuid PRIMARY KEY,
  tenant_id      uuid NOT NULL,
  seat_number    integer NOT NULL UNIQUE CHECK (seat_number BETWEEN 1 AND 1000),  -- signup order
  grant_source   text NOT NULL,   -- founding_1000 | launch_auto_grant_2026 | stripe_active
  granted_until  timestamptz,
  value_cents    integer NOT NULL DEFAULT 11988,   -- 12 x EUR 9.99
  celebrated_at  timestamptz,     -- the app showed the celebration
  created_at     timestamptz NOT NULL DEFAULT now()
);
```

- RLS: a member reads only their own row; no client writes.
- `claim_founding_seat(p_user_id, p_tenant_id)` (service role): idempotent seat
  + Premium until `max(current end, now + 365 days)`; never for
  `service_bot_accounts` / `notification_test_actors` / the system bot; a
  Stripe subscription is never overwritten; the launch grant is not extended;
  `SOLD_OUT` after seat 1,000. Seats are serialised by an advisory lock.
- Trigger `founding_seat_on_primary_membership` (AFTER INSERT ON
  `user_tenants`, primary membership) claims the seat at signup and never
  blocks the insert.
- `mark_founding_celebrated(p_user_id)` (service role) sets `celebrated_at`.
- The `FOUNDING` code (`founding_500`, 90 days) is deactivated.
- Migration `20261003100000_vtid_04859_founding_1000.sql`.

### Wallet System (USD / Credits / VTNA) — added 2026-07-17

> **VTID-04809 (2026-10-01, owner decision): `user_wallets.CREDITS` is the
> canonical VTNA ledger.** 1 VTNA = 1 CREDIT = **EUR 0.01** (pegged to EUR;
> the USD figure is a live ECB conversion). `user_wallets.earned_balance`
> holds the earned part of the CREDITS balance (`CHECK 0 <= earned_balance
> <= balance`); rewards (shop, subscription conversion) spend earned VTNA
> only, every other debit can only reach `balance - earned_balance`.
> `credit_wallet(p_tenant_id, p_user_id, p_amount, p_type, p_source,
> p_source_event_id, p_description)` now exists and writes here: `reward` →
> earned, `purchase` → purchased, negative amounts debit that bucket,
> idempotent per (member, `p_source_event_id`) via
> `wallet_transactions.idempotency_key`; `service_role` only. Members can no
> longer write `user_wallets`/`wallet_transactions` directly and
> `update_user_balance` refuses `'add'`. Migration
> `20261001180000_vtid_04809_vtna_reward_ledger.sql`.

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
  earned_balance NUMERIC(15,2) NOT NULL DEFAULT 0, -- VTID-04809: earned VTNA inside CREDITS
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
  idempotency_key TEXT,             -- VTID-04809: unique per (member, key)
  credit_source TEXT,               -- VTID-04809: 'earned' | 'purchased'
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
VTID-04809 adds the EUR peg rows **1 EUR = 100 CREDITS = 100 VTNA**, which
are the reference for every VTNA price shown to a member.

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

### notification_type_controls / notification_type_control_audit / notification_type_blocks — APPLIED 2026-09-28 (VTID-04674)
**Purpose:** the admin on/off switch per notification type (Admin › Notifications),
applied to every notification. Migration:
`supabase/migrations/20260926190000_vtid_04674_notification_type_controls.sql`,
applied live 2026-09-28 (`vtid_04674_notification_type_controls`) after the owner
approved the starting on/off list in session.

```sql
CREATE TABLE notification_type_controls (
  tenant_id uuid NOT NULL, type text NOT NULL,
  source_key text NOT NULL DEFAULT '',      -- '' = the type; 'AP-0101' = one automation's sends of it
  enabled boolean NOT NULL DEFAULT false,
  auto_registered boolean NOT NULL DEFAULT false,  -- added as off on first send
  reason text, updated_by uuid, updated_by_email text,
  created_at timestamptz, updated_at timestamptz,
  PRIMARY KEY (tenant_id, type, source_key)
);
CREATE TABLE notification_type_control_audit (id uuid PK, tenant_id, type, source_key,
  old_enabled, new_enabled, reason, actor_user_id, actor_email, created_at);
CREATE TABLE notification_type_blocks (tenant_id, type, source_key,
  block_reason text CHECK (block_reason IN ('admin_off','member_off')), day date,
  blocked_count int, last_blocked_at, PRIMARY KEY (tenant_id, type, source_key, block_reason, day));
-- All three: RLS on, no policies, REVOKE ALL from anon/authenticated → service role only.
ALTER TABLE notification_categories ADD COLUMN member_can_disable boolean NOT NULL DEFAULT true;
```

**Functions** (SECURITY DEFINER, `service_role` only):
- `notification_type_allowed(tenant, type, source_key)`: a missing row is inserted as OFF and answers false.
- `notification_member_allows(user, tenant, type)`
- `notification_record_block(...)`
- `notification_type_stats(tenant, days)`
- `notification_daily_activity(tenant, days≤90)`

**Trigger:** `trg_enforce_notification_type_controls` runs BEFORE INSERT on
`user_notifications`. It drops the row (returns NULL) and counts it when the
admin switch is off or the member switched the category off. On an internal
error it fails open with a WARNING.

**New index:** `idx_user_notifications_tenant_time`.

**New member categories:** `posts_reactions` and `tips_updates`.
`connections_social` gains `new_follower`; `direct_messages` gains `message_reaction`.

**Rules:** the gateway (`notification-controls-service.ts`) applies the same
decision before pushing: in `notifyUser`, `/push-dispatch` and the reminders push.
Every automation send carries `data.automation_id`.

---

### plan_sparring_sessions / plan_sparring_config / plan_sparring_shadow_log — Plan Sparring Gate, LOG MODE (VTID-04868) — committed, NOT yet applied

Every new plan is sparred by an independent partner before its VTID is
allocated (owner decisions 2026-10-03/04). P1 ships the gate in **log mode**:
nothing is blocked; each new VTID is recorded with what the gate would have
decided. Migration `20261004110000_vtid_04868_plan_sparring_gate.sql`,
hardened by `20261004120000_vtid_04868_plan_sparring_hardening.sql`
(committed, NOT yet applied — signatures below are the post-hardening ones);
rollback `docs/validation/VTID-04868/rollback.sql` (reverses both); tested on a
throwaway Postgres by `scripts/ci/test-vtid-04868-plan-sparring.sh`.

```sql
CREATE TABLE public.plan_sparring_sessions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id            uuid NOT NULL,          -- producer correlation id (incident_id for autonomous producers)
  plan_hash          text NOT NULL,          -- sha256 hex of the canonical plan text
  final_plan_hash    text,                   -- sha256 hex of the approved final plan
  producer           text NOT NULL,          -- claude-code | operator-chat | task-intake | self-healing | ...
  change_class       text NOT NULL,          -- light | standard | expedited
  trust_tier         text NOT NULL,          -- gateway | attested
  base_ref           text,                   -- commit SHA the partner read code at
  rounds             jsonb NOT NULL DEFAULT '[]',  -- append-only (plan_sparring_append_round)
  verdict            text NOT NULL DEFAULT 'in_progress',  -- in_progress | converged | escalated | pending_human_approval
  escalation_reasons text[] DEFAULT '{}',
  model_log          jsonb DEFAULT '[]',     -- [{round, provider, model, latency_ms, input_tokens, output_tokens}]
  human_approved_by  uuid,                   -- verified exafy_admin (gateway approve endpoint only)
  human_approved_at  timestamptz,
  approval_evidence  jsonb,
  vtid               text UNIQUE,            -- bound by the vtid_ledger gate
  created_at, updated_at timestamptz
);
CREATE TABLE public.plan_sparring_config (     -- single row, id = 1
  id int PRIMARY KEY CHECK (id = 1), mode text NOT NULL DEFAULT 'log',  -- off | log | enforce
  updated_at timestamptz
);
CREATE TABLE public.plan_sparring_shadow_log (
  id bigint identity PRIMARY KEY, vtid text, sparring_id uuid,
  outcome text NOT NULL,                       -- missing | invalid | ok | exempt
  detail jsonb,                                -- {mode, reason, actor, session_user, exempt_reason, source, raw_sparring_id, plan_hash}
  created_at timestamptz
);
```

- **RLS on all three; no anon/authenticated grants or policies.** service_role:
  SELECT everything; INSERT/UPDATE on sessions for every column **except
  `rounds`** (and identity columns on UPDATE); no DELETE; config and shadow
  log are read-only. The gateway's session INSERT therefore never names
  `rounds` (the column default `[]` applies). Rounds are written only by
  `plan_sparring_append_round(p_session uuid, p_round jsonb, p_expected_round int)`
  (hardening; replaces the 2-arg version): under `SELECT … FOR UPDATE` it
  raises SQLSTATE `PS409` (`round_conflict`) unless the session verdict is
  `in_progress` and `p_expected_round` = current round count + 1, so two
  racing appends of the same round cannot both land; it still refuses
  (`SESSION_FROZEN`) once the session is approved or bound to a VTID.
  service_role only.
- `allocate_global_vtid(p_source text DEFAULT 'api', p_layer text DEFAULT 'DEV',
  p_module text DEFAULT 'TASK', p_sparring_id uuid DEFAULT NULL,
  p_plan_hash text DEFAULT NULL)` — 20261004110000 replaced the 3-arg version
  with a 4-arg one; the hardening migration replaces that with this 5-arg one
  (each drop + create in one transaction). Non-null `p_sparring_id` /
  `p_plan_hash` land in `vtid_ledger.metadata.sparring_id` / `.plan_hash`.
  Body: the bounded collision-skipping loop of `20260628120000` (up to 1000
  `nextval()` draws until `VTID-XXXXX` is free, else `unique_violation`),
  shell-row shape and `allocator_version 'VTID-0542'` unchanged,
  `search_path = public, pg_temp`. EXECUTE: service_role only. Existing
  3-named-arg callers are unaffected.
- `submit_plan_sparring_record(p_plan_id, p_plan_hash, p_producer, p_change_class,
  p_rounds, p_base_ref, p_final_plan_hash, p_model_log, p_escalation_reasons)`
  — attested tier; always lands as `trust_tier='attested'`,
  `verdict='pending_human_approval'`, no approval; idempotent on
  (plan_id, plan_hash). service_role only.
- **Trigger `trg_plan_sparring_check` BEFORE INSERT ON `vtid_ledger`** →
  `plan_sparring_check()` (SECURITY INVOKER, so `current_user` is the inserting
  role) → `_plan_sparring_gate_eval()` (SECURITY DEFINER). An existing VTID
  (upsert) passes unlogged; mode `off` passes unlogged. A record is valid when
  verdict is converged/escalated, `human_approved_by` and `final_plan_hash` are
  set, `metadata.plan_hash` equals `final_plan_hash` (hardening; otherwise
  `invalid` with reason `plan_hash_missing` / `plan_hash_mismatch`) and it is
  unbound or bound to this VTID — it is locked `FOR UPDATE` and bound (`ok`). `metadata.sparring_exempt_reason` counts only for
  `vitana_governance_owner` (`exempt`, break-glass). Otherwise `missing` /
  `invalid`. **Log mode never raises** (an internal error becomes a WARNING),
  and a sparring_id that did not verify is moved to
  `metadata.sparring_id_unverified`. Enforce mode raises
  (`insufficient_privilege`) unless `ok`/`exempt`, and fails closed on an
  internal error. Enforce-mode rejections roll back with the insert, so they
  are not in the shadow log — the caller gets the error.
- Partial unique index `vtid_ledger_sparring_id_unique` on
  `vtid_ledger((metadata->>'sparring_id')) WHERE NOT NULL`.
- Role `vitana_governance_owner` NOLOGIN, granted to no one; may INSERT into
  `vtid_ledger` (policy `vtid_ledger_governance_owner_insert`), use
  `global_vtid_seq`, and read/update the config row.
- **Accepted residual on Supabase:** `postgres` can disable the trigger, change
  the config or grant itself the role — detected (hourly reconciler →
  `vtid.plan_sparring.tamper_detected`), not prevented. Mode changes only by a
  reviewed migration.

---

## ⚠️ DEPRECATED / DO NOT USE

### nav_catalog / nav_catalog_audit / nav_catalog_i18n — ARCHIVED to `legacy_archive` (VTID-04880)

The legacy voice navigator's screen catalog. Nothing reads or writes these
any more: the voice navigator reads the screen registry (vitana-v1
`src/navigation/registry/`, published as `/nav-registry.json`) since
VTID-04846, and the admin Catalog/Coverage/History pages were removed in
VTID-04853. Migration `20261005090000_vtid_04880_archive_nav_catalog.sql`
moves all three tables and their trigger function
`nav_catalog_touch_updated_at()` into the `legacy_archive` schema. No rows are
deleted; PostgREST no longer exposes them. The `nav_catalog_i18n.lang` FK to
`supported_locales` is dropped so archived rows never block removing a locale.
The rollback is in the migration header. Do not build anything new on them.

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
| 2026-10-05 | **VTID-04892 — Vitana Onboarding Assistant, slice 1 (shadow).** New tables (RLS on, service role writes only): `onboarding_coach_state` (one row per cohort member: stage d0…d61_90/done, pilot_stage_override, next_action_key, last_touch_at, snoozed_until, ignored_streak, opted_out_at; members read their own row), `onboarding_coach_decisions` (what the coach decided or would do, unique per member + local day + mode), `onboarding_touch_ledger` (one onboarding touch per member per local day, status pending/sent/failed, one retry). New functions (service role only): `claim_onboarding_touch(uuid, uuid, date, text, text)`, `finish_onboarding_touch(bigint, text)`. `user_proactive_touches.surface` CHECK widened to the presence pacer's 11 surfaces + `onboarding_coach` (NOT VALID then VALIDATE) — the four newer surfaces were previously rejected and never counted. Migration `20261005130000_vtid_04892_onboarding_coach.sql`. | Claude | VTID-04892 |
| 2026-10-04 | VTID-04868 hardening, **committed, NOT applied** (migration `20261004120000_vtid_04868_plan_sparring_hardening.sql`, review findings on PR #3899): `allocate_global_vtid` 4-arg dropped → 5-arg `(p_source, p_layer, p_module, p_sparring_id uuid DEFAULT NULL, p_plan_hash text DEFAULT NULL)` with the bounded 1000-step collision-skipping loop restored (service_role only); `_plan_sparring_gate_eval` binds a sparring id only when `metadata.plan_hash` = the session's `final_plan_hash` (`plan_hash_missing` / `plan_hash_mismatch` → `invalid`; log mode still never raises); `plan_sparring_append_round(uuid, jsonb)` dropped → `(uuid, jsonb, int p_expected_round)` raising SQLSTATE `PS409` on a stale/duplicate append or a non-`in_progress` session (service_role only). No table or config change. Rollback `docs/validation/VTID-04868/rollback.sql` reverses both VTID-04868 migrations. Tested twice + rollback on a throwaway Postgres (`scripts/ci/test-vtid-04868-plan-sparring.sh`). | Claude Code | VTID-04868 |
| 2026-10-04 | VTID-04868, **applied live 2026-10-04 08:26 UTC (RUN-MIGRATION run 37188907901)** (migration `20261004110000_vtid_04868_plan_sparring_gate.sql`, Plan Sparring Gate P1, LOG MODE): tables `plan_sparring_sessions`, `plan_sparring_config` (row mode='log'), `plan_sparring_shadow_log` (RLS on, no anon/authenticated access); role `vitana_governance_owner` (NOLOGIN); `allocate_global_vtid` 3-arg dropped → 4-arg with `p_sparring_id uuid DEFAULT NULL` (service_role only); `submit_plan_sparring_record()`, `plan_sparring_append_round()`; BEFORE INSERT trigger `trg_plan_sparring_check` on `vtid_ledger` (log mode never raises); partial unique index `vtid_ledger_sparring_id_unique`. Rollback `docs/validation/VTID-04868/rollback.sql`. Tested twice + rollback on a throwaway Postgres (`scripts/ci/test-vtid-04868-plan-sparring.sh`). See the section above. | Claude Code | VTID-04868 |
| 2026-10-01 | VTID-04798, **applied live** 2026-10-01 with the owner's go (migration `20261001160000_vtid_04798_memory_sensitivity.sql`, RUN-MIGRATION run 36895020174; verified: 457 fact rows and 65 items special_category, both triggers and constraints present): `memory_facts.sensitivity` and `memory_items.sensitivity` (text NOT NULL DEFAULT 'standard', CHECK in ('standard','special_category')) mark GDPR Art. 9 data. One rule decides it: immutable function `memory_sensitivity_of(text)` on the fact key / category key, applied by BEFORE INSERT/UPDATE triggers `trg_memory_facts_sensitivity` / `trg_memory_items_sensitivity` (they only ever raise to special_category) and by a backfill (measured 2026-10-01: 95 of 392 current fact keys, 457 fact rows, 65 items). `memory_items.sensitivity_flag` (VTID-01116, never written) is left as is. Tested on a throwaway Postgres: `scripts/ci/sql-tests/run-memory-sensitivity-test.sh` (CI `SQL-MEMORY-SENSITIVITY.yml`). | Claude Code | VTID-04798 |
| 2026-10-01 | VTID-04776, **committed, NOT applied** (migration `20261001120000_vtid_04776_voice_session_facts.sql`, additive): table `voice_session_facts` (one row per ORB voice session, PK `session_id`; RLS on, service_role only), view `voice_session_facts_hourly` (security_invoker), trigger `trg_voice_session_facts_touch`, function `voice_session_facts_backfill(p_since)` (service_role, max 30 days back, not run by the migration). Read by `/api/v1/voice/supervisor/*` (VTID-04776/04778/04780). The gateway writes it fire-and-forget and logs loudly while the table is missing, so apply before relying on the Supervisor; then run the backfill for the history you want. | Claude Code | VTID-04776 |
| 2026-09-28 | VTID-04674, **applied live** (`vtid_04674_notification_type_controls`, starting list approved by the owner in session): the admin switch per notification type. It adds `notification_type_controls` (+ audit, + daily block counts), `notification_categories.member_can_disable`, the decision functions, the BEFORE INSERT guard on `user_notifications`, two read models, index `idx_user_notifications_tenant_time`, and member categories `posts_reactions` and `tips_updates`. Starting state: 13 types ON for every tenant (the ones delivered in the last 30 days plus `reminder_due`); everything else OFF and registered as OFF on first send. Idempotent; tested twice against a local Postgres (`docs/validation/VTID-04674/`). Verified live read-only: 26 rows ON (13 types × 2 tenants), trigger enabled, categories extended, 0 blocks at apply time. | Claude Code | VTID-04674 |
| 2026-09-26 | VTID-04668, **not yet applied** (migration `20260926160000_vtid_04668_recommendation_priority.sql`, additive): nullable `autopilot_recommendations.priority_score numeric` and `autopilot_recommendations.quality jsonb`, plus partial index `idx_autopilot_recommendations_dev_priority` on `(status, priority_score DESC) WHERE user_id IS NULL`. Written by the gateway for developer rows only (`user_id IS NULL`, not `community` / `operator_onramp`): `priority_score = value × confidence × success_odds / max(expected_cost_usd, 0.05)`; `quality = {version, value, confidence, success_odds, expected_cost_usd, expected_input_tokens, executable, basis, scored_at}` (VTID-04669 adds `review`, `review_attempts`, `review_last_attempt_at`). The same write maps `impact_score` (from value) and `effort_score` (from expected cost) so older readers keep working. Community rows keep NULL. Apply before the gateway code is deployed. | Claude Code | VTID-04668 |
| 2026-09-26 | VTID-04624, **applied live** (`vtid_04624_operator_readonly_query`): function `operator_readonly_query(q text) RETURNS jsonb` (SECURITY INVOKER, EXECUTE granted to `service_role` only — revoked from public/anon/authenticated). Backs the Operator Console's `dev_run_sql_readonly` on the live database (owner decision 2026-09-26; the Aurora copy the tool was designed for has had no replication since the 2026-09-21 full load). Sets `transaction_read_only=on` and `lock_timeout=2s` before executing the statement as a subquery of a jsonb aggregate; the PostgREST login role caps each call at 8 s. Verified live in a rolled-back transaction: a read returns rows; an INSERT through a function, switching back to read-write and a stacked statement are all refused; `auth.users` is not readable by service_role. Migration `20260926110000_vtid_04624_operator_readonly_query.sql`. | Claude Code | VTID-04624 |
| 2026-09-25 | VTID-04561, **applied live** (`vtid_04561_one_role_truth`): the two role switchers now keep the two role tables in step. `set_role_preference()` (community app) also upserts `user_active_roles`; `me_set_active_role()` (Command Hub) also upserts `role_preferences` when the caller has a tenant. One-time backfill in both directions (5 of 6 users with rows disagreed before). Two `role_preferences` rows still differ from `user_active_roles` afterwards; both belong to a secondary tenant, and the ORB reads the role per tenant, so they are expected. Migration `20260925120000_vtid_04561_one_role_truth.sql`. | Claude Code | VTID-04561 |
| 2026-09-24 | VTID-04494, **applied live**: `write_fact()` takes a per-key `pg_advisory_xact_lock` (tenant, user, entity, fact_key), compares against the newest current row and supersedes EVERY other current row (was `FOR UPDATE SKIP LOCKED` + one-row supersede, which let concurrent writers create duplicate current facts that never cleared). One-time repair: 80 duplicate current rows in 70 key groups marked superseded by the newest row; nothing deleted. Invariant: one `superseded_by IS NULL` row per (tenant_id, user_id, entity, fact_key). | Claude Code | VTID-04494 |
| 2026-09-24 | VTID-04489, **applied live** (read-only, additive): functions `get_index_boost(p_user_id uuid) RETURNS jsonb` (SECURITY DEFINER, `authenticated` only, NULL without a JWT) and helper `_index_boost_activity_key(text)` (IMMUTABLE; normalises free-text workout `activity_type` — e.g. `laufen`, `Fahrrad gefahren`, `Padel-Tennis` — to running / cycling / strength / racket / yoga_pilates / swimming / walking / workout). Returns the member's top 3 activity drivers over the last 7 days (when at least 2 things were logged in them) or else 30: workouts by type, meals, water, sleep, meditation (`health_features_daily`) and guided journey sessions (`journey_session_index_awards`), with counts; drivers whose Index pillar rose rank first, then by count. `kind` = `boost` when the Index rose over the window, else `active`. Visible to every signed-in member with numbers (owner decision 2026-09-24); hidden when `profiles.account_visibility.indexBoost` = `private` (or `connections` for non-connections). New visibility key `indexBoost`, default `public`. Migration `20260924170000_vtid_04489_index_boost.sql`; ranking corrected and re-applied the same day before any consumer shipped. | Claude Code | VTID-04489 |
| 2026-09-24 | VTID-04498, **applied live** (read-only, additive): function `get_index_standing(p_user_id uuid) RETURNS jsonb` (SECURITY DEFINER, `authenticated` only, NULL without a JWT) behind the profile Vitana Index card's real "Top X%" badge. Cohort = the subject's tenant, each member's latest `vitana_index_scores` row in the last 30 days, excluding `service_bot_accounts` and `notification_test_actors`. Returns `{show:true, top_percent, cohort_size}` only when the cohort has >= 20 members, at least one member scores lower (48 of 66 members were tied at the starting score on 2026-09-24 and would otherwise each read "Top 29%"), and the rank is in the top half; otherwise `{show:false, reason}` with no percentage. Migration `20260924190000_vtid_04498_index_standing.sql`. | Claude Code | VTID-04498 |
| 2026-09-24 | VTID-04483, **applied live** (read-only, additive): function `get_profile_health_summary(p_user_id uuid) RETURNS jsonb`, SECURITY DEFINER, `authenticated` only (anon and PUBLIC revoked; no JWT returns NULL). Returns the latest Vitana Index score, 7-day change and community standing (`top_percent`, `community_average`, `cohort_size`: latest score per member in the subject's tenant over the last 30 days, excluding `service_bot_accounts` and `notification_test_actors`, and only when the cohort has at least 20 members, otherwise `available:false` with the current size). Pillars with 7-day change and achievements (`personal_best` after 7 scored days, `rising_week` at +20, `logging_streak` at 3+ days) only for the owner or when the subject shares via new `profiles.account_visibility` key `vitanaHealth` (default `private`; `connections` resolved by `get_viewer_relationship`). Owner-only activity from `health_features_daily` (7-day sleep, water, workouts, steps, meditation, logging streak), read here because that table's SELECT policy gates on `current_tenant_id()`, which is NULL for browser JWTs. Migration `20260924150000_vtid_04483_profile_health_summary.sql`. Verified live in a rolled-back transaction: owner gets pillars + activity, a visitor of a non-sharing member gets score + standing only. Consumed by `exafyltd/vitana-v1` behind `VITE_HEALTH_REAL_DATA` (default off). | Claude Code | VTID-04483 |
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
| 2026-09-28 | Five feature data layers that were documented/declared but never existed live, now APPLIED: autopilot_prompts + autopilot_prompt_prefs, risk_mitigations, overload_*, taste_*/user_*_profiles, preference modeling (explicit table renamed user_explicit_preferences; public.user_preferences is the settings table). New `caller_tenant_id()`. See the section at the end of this file. | Claude | VTID-04716 / 04717 / 04718 / 04719 / 04720 |
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
| 2026-09-24 | `autopilot_recommendations.role_scope` is now actually set: existing rows backfilled (`source_type='community'` → `community`, `user_id IS NULL` system findings → `developer`) and a BEFORE INSERT trigger `trg_autopilot_recommendations_role_scope` (`autopilot_recommendations_set_role_scope()`) sets it for every writer when a row arrives as `any`/NULL. Applied live. The gateway now decides the Autopilot lineup server-side from the active role. | Claude | VTID-04500 |
| 2026-09-24 | Added nullable `autopilot_recommendations.action` jsonb (`{kind, params}`, closed registry in `services/community-autopilot/action-registry.ts`; NULL = informational). Executing an action writes one `agent_runs` row (`plane='community_autopilot'`, `agent_id='community-autopilot'`, `idempotency_key='community_autopilot:<rec>:<kind>'`). Applied live. | Claude | VTID-04503 |
| 2026-09-24 | Unique partial indexes `uq_referrals_referred_id` on `referrals(referred_id) WHERE referred_id IS NOT NULL` (one referral per member; the invite claim is idempotent on it) and `uq_sharing_links_member_invite` on `sharing_links(user_id) WHERE target_type='member_invite'` (one reusable personal invite link per member). Both tables had no duplicates. Migration `20260924200000_vtid_04508_invite_attribution.sql`. Applied live. | Claude | VTID-04508 |
| 2026-09-24 | **Pending drop, not yet applied:** `autopilot_actions`, `autopilot_action_templates`, `automation_executions`, `autopilot_feedback` — 0 rows each (measured live), no dependent view or function, only FK into them is `autopilot_feedback → autopilot_actions`. Never written; Autopilot state is `autopilot_recommendations`, automation runs are `automation_runs`. Readers removed from the `fetch-user-context`, `get-proactive-context`, `analyze-patterns` and `request-account-deletion` edge functions (`exafyltd/vitana-v1`). Guarded migration `vitana-v1/supabase/migrations/20260924220000_vtid_04514_drop_dead_autopilot_tables.sql` refuses a table with rows; apply it only after those edge functions are deployed. `automation_rules` and `tenant_autopilot_runs` are kept (still read). | Claude | VTID-04514 |
| 2026-09-29 | `product_clicks` gains `referrer_user_id` (recommender of the validated referral, stored on the click) and `attribution_rejected_reason` (why a `?rec_id=` was dropped, or `unverified`), plus partial index `idx_product_clicks_referrer`. `product_orders.user_id` becomes nullable so a signed-out buyer's sale can be attributed (RLS `user_id = auth.uid()` never matches NULL). Migration `20260929120000_vtid_04740_referrer_on_click_anonymous_buyers.sql`. | Claude | VTID-04740 |
| 2026-09-29 | `product_orders.tenant_id` becomes nullable: a signed-out buyer's click records no tenant, and the Awin order sync copies the click's tenant onto the order, so without this the anonymous sale's upsert failed. NULL is the honest value for an unknown buyer's tenant; RLS on `product_orders` does not use `tenant_id`. Migration `20260929120200_vtid_04740_product_orders_tenant_nullable.sql`. | Claude | VTID-04740 |
| 2026-09-29 | RLS `product_clicks_select_own` narrowed to `user_id = auth.uid()`. It had also exposed every anonymous click (`user_id IS NULL`) to every authenticated user, and a click now carries `referrer_user_id`. No client reads the table; gateway reads use the service role. Migration `20260929120700_vtid_04740_product_clicks_select_own_only.sql`. | Claude | VTID-04740 |
| 2026-09-29 | `recommendation_commissions.status` CHECK widened to `pending`/`credited`/`skipped_ineligible`/`failed`/`reversed`; new `confirm_after`, `confirmed_at`, `reversed_at`, `reversal_reason` and partial index `idx_recommendation_commissions_due`. A conversion the network has not approved is held `pending` until `confirm_after` (window from `admin_settings.recommendation_commission_return_window_days`, seeded `{"days":30}`), then credited or reversed; network-approved conversions (Awin) confirm at once. Migration `20260929120100_vtid_04741_recommendation_commission_hold.sql`. | Claude | VTID-04741 |
| 2026-09-29 | New functions `confirm_recommendation_commission(p_commission_id uuid)` and `reverse_recommendation_commission(p_order_id uuid, p_reason text)` (SECURITY DEFINER, `service_role` only, return `jsonb`). Each confirms or reverses a held commission in ONE transaction under a row lock. Confirm: re-check the order, `credit_wallet_for_earning`, status and stats. Reverse: `pending → reversed`, or a paid commission reported once, with its OASIS event in the same commit. No table changes. Migration `20260929120300_vtid_04741_commission_confirm_reverse_functions.sql`. | Claude | VTID-04741 |
| 2026-09-29 | `confirm_recommendation_commission` also locks the `product_orders` row (`FOR UPDATE`) when it re-checks that the order is still a sale, so a decline that commits first prevents payment. It also re-checks the payee against `service_bot_accounts` and `notification_test_actors`: an account registered as one during the hold is closed `skipped_ineligible` (`reversal_reason='excluded_account'`), never paid. CREATE OR REPLACE only. Migration `20260929120400_vtid_04741_confirm_commission_order_lock_exclusions.sql`. | Claude | VTID-04741 |
| 2026-09-29 | `reverse_recommendation_commission` also locks the `product_orders` row and reverses or reports only while the order is still `refunded`/`cancelled`/`chargeback`; otherwise it returns `order_not_reversing` and changes nothing. The caller's read can be stale if a later sync has moved the order back to `converted`. CREATE OR REPLACE only. Migration `20260929120500_vtid_04741_reverse_commission_order_recheck.sql`. | Claude | VTID-04741 |
| 2026-09-29 | At payment, `confirm_recommendation_commission` refreshes `payout_amount_minor`, `currency` and `vitana_commission_cents` from the order's current `commission_cents` and `currency`, at the row's recorded `rate_applied` (never today's settings). A network can correct an order after the pending row was written. It returns `order_no_commission` when the order no longer carries a commission. CREATE OR REPLACE only. Migration `20260929120600_vtid_04741_confirm_commission_refresh_terms.sql`. | Claude | VTID-04741 |
| 2026-10-01 | **VTID-04809 — `user_wallets.CREDITS` is the canonical VTNA ledger.** New `user_wallets.earned_balance` (CHECK `0 <= earned_balance <= balance`, CREDITS only); new `wallet_transactions.idempotency_key` (unique per member) and `credit_source` (`earned`/`purchased`). `credit_wallet()` re-created on this ledger with the signature its callers already used (it never existed live, so diary-streak, milestone, AP-0708, autopilot-completion and Stripe credit-pack credits were silently dropped). Closed two self-credit holes: dropped RLS policy `Users can update their own wallets` and revoked INSERT/UPDATE/DELETE/TRUNCATE on `user_wallets`/`wallet_transactions` from `anon`/`authenticated`; `update_user_balance` refuses `'add'` and is no longer executable by `anon`. EUR peg rows in `exchange_rates`. Migration `20261001180000_vtid_04809_vtna_reward_ledger.sql`. | Claude | VTID-04809 |
| 2026-10-03 | **VTID-04864 — VTNA reward rules, no double payouts.** `complete_autopilot_recommendation()` re-created with its 10-VTNA reward for `onboarding_*` suggestions removed (the same first steps are paid once by the milestone service from the VTNA rule table, `services/gateway/src/services/rewards/vtna-reward-rules.ts`); `reward` in its response is now always 0. Migration `20261003130000_vtid_04864_autopilot_completion_no_double_reward.sql`. Also VTID-04860: `knowledge_docs` text rewritten VTN → VTNA (`20261003120000_vtid_04860_knowledge_docs_vtna_name.sql`). No table changes. | Claude | VTID-04864 / VTID-04860 |
| 2026-10-03 | **VTID-04859 — Founding 1000.** New table `founding_members` (seat 1..1000 in signup order, grant source, granted_until, value_cents 11988, celebrated_at; RLS own-row read). New functions `claim_founding_seat(uuid, uuid)` and `mark_founding_celebrated(uuid)` (service role). New trigger `founding_seat_on_primary_membership` on `user_tenants`. Backfill seats every existing primary member in signup order and grants a Premium year where no Stripe subscription or launch grant exists. `redemption_codes.FOUNDING` (founding_500) deactivated. Migration `20261003100000_vtid_04859_founding_1000.sql`. | Claude | VTID-04859 |
| 2026-10-05 | **VTID-04878 — VTNA earning pays.** New functions (service role only, no table changes): `claim_capped_reward(uuid, uuid, text, text, integer, integer, text, timestamptz)` pays one occurrence of a capped VTNA rule (`autopilot_action_done` 2/day, `live_room_15min` 3/week, `index_new_best` 1/week, UTC calendar windows) under a per-member+rule advisory lock, counting `wallet_transactions.metadata->>'source'` and crediting via `credit_wallet()` with key `<rule>:<ref>`; refuses test/service accounts. Read-only sweep candidates: `reward_sweep_is_excluded(uuid)`, `reward_sweep_members(uuid, integer)`, `reward_sweep_live_room_candidates(timestamptz)` (15 full minutes by timestamps — `live_room_attendance.duration_minutes` rounds), `reward_sweep_index_candidates(date)`. Migration `20261005100000_vtid_04878_claim_capped_reward.sql`. | Claude | VTID-04878 |

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
> **Superseded 2026-09-28:** this definition was never applied. The table that exists live is the VTID-04717 one described in "Feature data layers applied 2026-09-28" at the end of this file.

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

**VTID-04762 (Audiobook Season 0):** now **100 sessions / 260 topics**.
Migration `20261001120000` prepended the six-episode Prolog (T255-T260,
`chapter_id='prolog'`, shown as Season 0 of the Audiobook) at sessions 1-6 and
shifted everything else to 7-100. The `session` CHECK is now
`BETWEEN 1 AND 100`; `current_session` pointers > 1 shifted +6 (members who
already started keep their place and the Prolog counts as heard); the current
published snapshot was rewritten in place; English translation rows (incl.
`vitana_voice_script`) ship with it and I18N-DB-SEED fills the other locales.

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

**Commission lifecycle (VTID-04741):** `recommendation_commissions.status`
is `pending` (held until `confirm_after`) → `credited` (paid to the wallet,
`confirmed_at`), or `reversed` (order refunded/cancelled/charged back before
payment, `reversed_at`/`reversal_reason`); `skipped_ineligible` and `failed`
as before. Network-approved conversions confirm at once. A reversal after
payment is reported as `marketplace.recommendation.commission_reversal_after_payout`,
not clawed back (clawback policy is open, architecture D-11), and only once
(marked by `reversal_reason` on the `credited` row). Confirm and reverse each
run as one transaction under a row lock (`confirm_recommendation_commission`,
`reverse_recommendation_commission`), so a crash never leaves a commission
marked paid without money, and a confirm and a reversal of the same order
serialize.

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

**VTID-04561 (`20260925120000_vtid_04561_one_role_truth.sql`, applied 2026-09-25):
one role truth.** `role_preferences` (written by the community app's
`set_role_preference()`, read by the ORB per tenant) and `user_active_roles`
(written by the Command Hub's `me_set_active_role()`) used to drift apart, so
the same user could be "developer" in one app and "community" in the other.
Both functions now write BOTH tables in the same transaction, and a one-time
backfill aligned the existing rows. `user_active_roles` is the canonical one
for the Command Hub; `role_preferences` stays per tenant for the member app.

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
| `business_details` | JSONB | VTID-04481: key `platform_detection` = `{url, connector_id, provider_id, platform_name, confidence, detected_at}`, written by `POST /api/v1/partner-onboarding/:orgId/detect` (last detection wins). |
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

`step_key = 'verification'` (VTID-04486, written by `POST /api/v1/partner-onboarding/:orgId/verification/check`): `detail` = `{level_required, level_reached, checks: {email_verified, domain, vat, business_verification, licence}, missing, domain_method, domain_token, vat_registered_name, vat_error?, facts: {website, country, vat_id}, checked_at}`. The checklist treats the row as void (`todo`, `facts_changed`) once the org's website, country or VAT id no longer equals `detail.facts`. The same check writes `partner_organizations.trust_level` (level reached, 0 when none). No schema change.

`step_key = 'catalogue'` (VTID-04488, written by `/api/v1/partner-onboarding/:orgId/catalogue/*` after every merchant or product change): `status` is `in_progress` once the org has a merchant and `done` once that merchant has at least one product; `detail` = `{merchant_id, product_count, counted_at}`. The org's merchant is the `merchants` row with `partner_organization_id` = the org (created with `source_network = 'supplier_referral'`, `source_merchant_id = 'supplier_referral:org:<orgId>'`, `onboarding_status = 'draft'`, `is_active = false`, no `owner_user_id`), or the owner's unlinked supplier-portal merchant, adopted by setting its `partner_organization_id`. Products stay `is_active = false`. No schema change.

`step_key = 'mapping'` (VTID-04499, reconciled by `GET`/`POST /api/v1/partner-onboarding/:orgId/connections`): `done` once any of the org's VCAOP connections is `certified`, `active` or `degraded`, `in_progress` while one exists, no row while there are none; written only when the status moves. `detail` = `{source: 'connections', connections: [{id, state}], reconciled_at}`. The org's connections hang off one `partner_tenant` with `partner_organization_id` = the org (`owner_user_id` = the org owner, so the VCAOP `/my` per-connection endpoints serve them). No schema change.

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

### Supplier go-live lists products (VTID-04769) — APPLIED to the live project 2026-10-01

Migration `20261001120000_vtid_04769_supplier_go_live_lists_products.sql`.
`products.is_active` stays the one truth every member-facing reader filters
on; for **supplier** products (merchant linked to a partner organization, or
owned by a test/service account) the database now maintains it:

- `products.first_listed_at TIMESTAMPTZ` — when a supplier product was first
  switched on; `NULL` = never-listed draft.
- `products.listing_hold TEXT` (`org_not_live` | `excluded_account`) — why the
  gate is holding a product off; `NULL` = not held.
- Org reaches `lifecycle_state = 'live'` (also via the legacy
  `POST /partner-orgs/:id/activate` status write) → its waiting products
  (drafts and held ones) go on. Products added while live go on at once.
- Org paused/suspended, or its owner registered in `service_bot_accounts` /
  `notification_test_actors` → its products go off with `listing_hold` set,
  and come back when that clears.
- An explicit `is_active` write (admin) is a decision: switch-off is never
  undone by a go-live; switch-on while the org is not live is held until it is.
- Network products (no partner org, no owner) are never read or written.

Helpers `supplier_listing_block(uuid)` and `refresh_supplier_listings(uuid)`
are service_role only. Scenarios: `docs/validation/VTID-04769/`.


### Discover categories as data (VTID-04783) — APPLIED 2026-10-01 (VTID-04783)

Migration `20261001140000_vtid_04783_discover_categories.sql`.

- `discover_categories(key PK, label_key, icon, sort_order, is_active)` and
  `discover_subcategories(category_key FK, key, label_key, sort_order, is_active)`
  — Discover's product categories. `label_key` is a frontend i18n key. Public
  read (RLS select-all), service-role write. Adding a category is a row here
  plus its label in the frontend catalogue.
- `catalog_verticals.discover_category` (FK) — the Discover category a
  supplier vertical lands in; NULL = none yet (services, until step C).
- `trg_products_discover_category` (BEFORE INSERT/UPDATE OF category,
  subcategory, merchant_id) — supplier products only (merchant linked to an
  org or owned by a user): category becomes the vertical's Discover category;
  a subcategory survives only if it belongs to that category. Network
  products are untouched.
- `discover_category_counts()` — active products per (category, subcategory)
  in known categories; backs `GET /api/v1/discover/categories`.
---

## Memory — canonical stores, embeddings, health (VTID-04341 / 04342 / 04343 / 04345, 2026-09-23) — APPLIED to the live project

Plan and rationale: `docs/MEMORY-SYSTEM-PLAN.md`. Canonical user memory is two tables:

| Table | Holds | Embedding |
|---|---|---|
| `memory_facts` | Current key/value facts with provenance and supersession (`superseded_by IS NULL` = current). Written only through `write_fact()`. | `embedding vector(1024)`, `embedding_model = 'amazon.titan-embed-text-v2:0'` |
| `memory_items` | Episodes (conversation turns today; session summaries, diary, daily learnings in later phases). | `embedding vector(1024)`, same model |

- **Sensitivity (VTID-04798)** — every row of both tables carries `sensitivity`: `special_category` (health, religion, sexual orientation, ethnic origin, political opinion, genetic/biometric data; for this app also diet, intake, steps and the Vitana Index) or `standard`. The database sets it from the key (`memory_sensitivity_of`), whoever writes. `special_category` rows reach the member's own surfaces and the Health Coach only; anything that can show a row to another member reads `standard` only (the member ranker).
- **Role scope** — `memory_items.active_role` (NULL = personal, VTID-04367). `memory_facts` is personal memory only: a conversation on a work surface (Command Hub, admin, BackOffice, commerce) writes no facts (VTID-04798).

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

## Testing & QA results store — `ci_test_runs`, `ci_test_sync_state` (VTID-04641, 2026-09-26) — APPLIED to the live project 2026-09-26

Migration `20260926130000_vtid_04641_ci_test_results.sql`. History of every
completed GitHub Actions run of a test / gate / monitor / e2e / deploy-smoke
workflow in `exafyltd/vitana-platform` and `exafyltd/vitana-v1` (the kinds and
environments come from the test catalog, VTID-04637), for the Command Hub
Testing & QA screens. Written only by the gateway
(`services/testing/test-results.ts`, lazy sync on read, upsert on
`(repo, run_id)`). RLS enabled with no policy: service role only. The older
`test_runs` / `test_results` / `test_cycles` tables (hub-started Playwright
runs) are unchanged.

### ci_test_runs

| Column | Type | Notes |
|---|---|---|
| `repo` | text | PK part. `exafyltd/vitana-platform` or `exafyltd/vitana-v1` |
| `run_id` | bigint | PK part. GitHub Actions run id |
| `run_attempt` | integer | a re-run keeps `run_id`, bumps this, and replaces the verdict |
| `workflow_file` / `workflow_name` | text | e.g. `TEST-SUITE.yml` |
| `kind` | text | catalog kind: test, gate, monitor, e2e, deploy_smoke |
| `environments` | text[] | catalog environments at ingest: dev_pr, nightly, staging, production |
| `event`, `branch`, `head_sha`, `actor`, `html_url` | text | from the run |
| `status` | text | always `completed` (only finished runs are stored) |
| `conclusion` | text | success, failure, cancelled, skipped, timed_out, … |
| `run_created_at` / `run_started_at` / `run_updated_at` | timestamptz | |
| `duration_s` | integer | started → last update |
| `jobs` | jsonb | `[{name, conclusion, started_at, completed_at}]` |
| `ingested_at` | timestamptz | |

Indexes: `(repo, workflow_file, run_created_at desc)`, `(run_created_at desc)`.

### ci_test_sync_state

One row per repository: `synced_through` (newest stored `run_created_at`; the
next sync re-reads 6 h before it), `last_synced_at`, `last_error`,
`last_ingested`, `updated_at`.


## Feature data layers applied 2026-09-28 (VTID-04716 / 04717 / 04718 / 04719 / 04720) — APPLIED to the live project

Service Health (VTID-04665) showed five features down because their tables or
functions had never existed live. Each migration below is idempotent and was
executed against Postgres 16 twice before it was applied.

Hardening (`20260928200500`, applied): anon and PUBLIC cannot execute any of these functions; members
(authenticated) execute the member-facing ones, which are scoped to `auth.uid()`. `is_in_quiet_hours`
has a fixed `search_path`.

### `public.caller_tenant_id()` (VTID-04718)
SECURITY DEFINER, STABLE. Returns the caller's tenant in this order:
1. `current_tenant_id()`, from the explicit request context or JWT claim;
2. the JWT `app_metadata.active_tenant_id`;
3. the caller's primary `user_tenants` row;
4. otherwise their oldest membership.

Only the D39/D51/preference-modeling functions and policies use it.
`current_tenant_id()` is unchanged, because it backs RLS on many other tables
and returns NULL for plain Supabase JWTs.

### autopilot_prompts, autopilot_prompt_prefs (VTID-04716; design VTID-01089)
Columns are as in `20251231000001_vtid_01089_autopilot_prompts.sql`, except
that the foreign keys point at `tenants(tenant_id)`; the original `tenants(id)`
reference is why it never applied.
- **RLS:** members read and update their own rows and insert their own prefs.
- **Functions:** `count_prompts_today` and `get_user_prompt_prefs` are
  `service_role` only, because they take any user id. `is_in_quiet_hours` is a
  pure function.
- **Writes:** the prompt service writes with the service role.
- **Still missing:** `matches_daily` (VTID-01088) does not exist, so no prompts
  are generated yet.

### risk_mitigations (VTID-04717; engine VTID-01143)
| Column | Type | Notes |
|---|---|---|
| `id` | uuid | PK (the engine supplies `mitigation_id`) |
| `tenant_id` | uuid | FK `tenants(tenant_id)` |
| `user_id` | uuid | |
| `risk_window_id` | uuid | |
| `domain` | text | sleep, nutrition, movement, mental, routine, social |
| `confidence` | numeric | 0-100 |
| `suggested_adjustment`, `why_this_helps` | text | |
| `effort_level` | text | low, medium, high (default low) |
| `source_signals` | uuid[] | |
| `precedent_type` | text | user_history, general_safety |
| `disclaimer` | text | |
| `status` | text | active, dismissed, acknowledged, expired, superseded |
| `expires_at`, `dismissed_at`, `acknowledged_at` | timestamptz | |
| `dismiss_reason` | text | |
| `generated_by_version`, `input_hash`, `suggestion_hash` | text | |
| `created_at`, `updated_at` | timestamptz | |

- **RLS:** a member reads and updates only their own rows. They insert only
  their own rows, into a tenant they belong to (`caller_is_tenant_member()`).
- **Notifications:** `trg_notify_risk_mitigation` is **not** attached. It would
  push to members, so turning it on is a product decision.

### overload_detections, overload_baselines, overload_patterns (VTID-04718; design VTID-01145)
Columns are as in `20260103000000_vtid_01145_overload_detection.sql`.
`overload_patterns.created_at` is now declared in the table; the original only
added it after the index that needs it.

Functions: `overload_compute_baselines`, `overload_get_baselines`,
`overload_detect`, `overload_get_detections`, `overload_dismiss`,
`overload_record_pattern`, `overload_explain`. They read `capacity_state`.

### Taste alignment (VTID-04719; design VTID-01133)
Tables: `user_taste_profiles`, `user_lifestyle_profiles`, `taste_signals`,
`taste_reactions`, `taste_alignment_bundles`, `taste_alignment_audit`.

Functions: `taste_profile_get/set`, `lifestyle_profile_get/set`,
`taste_alignment_bundle_get`, `taste_reaction_record`,
`taste_alignment_audit_get`. Audit pagination now runs in a subquery; the
original failed at runtime.

### Preference modeling (VTID-04720; design VTID-01119)
Tables: `preference_categories` (seeded), `user_explicit_preferences`,
`user_preference_inferences`, `user_constraints`, `user_preference_bundles`,
`user_preference_audit`.

The explicit-preference table is called **`user_explicit_preferences`**:
`public.user_preferences` already exists as the per-user settings table
(autopilot/STT/TTS/AI columns) and is untouched.

Functions: `preference_set/delete`, `constraint_set/delete`,
`preference_bundle_get`, `preference_confirm`, `inference_reinforce/downgrade`,
`preference_get_audit` (pagination fixed as above).

### Jev spend and shadow decisions (VTID-04754)
Tables: `jev_spend_counters` (PK `tenant_id, plane, month`; `calls`,
`input_tokens`, `cost_usd`), `jev_shadow_decisions` (one row per shadow or
enforce gate run: `gate`, `decision`, `mode`, `plane`, `tenant_id`,
`subject_type`/`subject_ref`, `jev_outcome`, `jev_verdict`, `jev_confidence`,
`system_action`, later `agreed`/`outcome`/`outcome_at`, `cost_usd`).
Service role only; RLS on with no client policies. Platform-level spend
(no tenant) is counted under `00000000-0000-0000-0000-000000000000`.

Functions: `jev_record_spend(tenant, plane, input_tokens, cost_usd)` (atomic
increment, returns the tenant's month total), `jev_shadow_gate_stats(days)`
(per-gate calls, decided, agreement rate, cost). Per-tenant control lives in
`tenant_settings.feature_flags.jev = {enabled, planes[], monthly_budget_usd}`
(no new column). Since VTID-04857 the budget is compared with the sum of the
tenant's `member`/`patient`/`partner_org` rows only (internal and
system_autopilot are uncapped); member-content calls are counted under
`member`. Budgets set by `data-fixups/20261003120000_vtid_04857_jev_community_budgets.sql`
(maxina 50, alkalma 10).
Community Class A shadow rows (VTID-04879) use `plane = 'member'` and the
subject types `community_utterance`, `community_marketplace_need`,
`community_memory_turn` and `community_ticket`; `subject_ref` is a hash of
session/turn ids, never member text or ids. No column change.

### Jev member daily quota (VTID-04872)
Table: `jev_member_daily_counters` (PK `tenant_id, user_id, day`; `calls`,
`updated_at`) — Class B community Jev calls per member per UTC day. Function
`jev_member_quota_bump(tenant, user)` increments atomically and returns
today's count. Service role only; RLS on with no client policies. `user_id`
is the member's auth uuid, so `erase_user_data()` deletes the rows with the
account. Limit `JEV_MEMBER_DAILY_QUOTA` (default 300), mode
`JEV_MEMBER_QUOTA_MODE` (shadow by default; enforce refuses with a 429
fallback). Rows older than a week carry no meaning.

## Account erasure — `erasure_registry`, `erase_user_data()` (VTID-04765, 2026-10-01) — NOT YET APPLIED

`request-account-deletion` (vitana-v1 edge function) deleted 20 hand-listed tables, then the auth user. On 2026-10-01 the live schema had ~200 more public tables whose `user_id` does not cascade from `auth.users` — memory, diary, health, notifications among them — so their rows outlived the account.

Migration `supabase/migrations/20261001120000_vtid_04765_erase_user_data.sql`.

### erasure_registry
| Column | Type | Notes |
|---|---|---|
| `table_name` | text PK | a public table |
| `action` | text | only `retain` |
| `reason` | text NOT NULL | the legal reason (bookkeeping retention, allowlists) |
| `created_at` | timestamptz | |

Seeded with the financial ledgers and order/payment records (HGB §257, AO §147; to be confirmed by counsel) and the two test/service-account allowlists. service_role only.

### `erase_user_data(p_user_id uuid, p_dry_run boolean default false) returns jsonb`
- Finds every ordinary or partitioned public table with a uuid `user_id` itself; new tables are covered without a list.
- Skips `retain` tables and tables whose `user_id` cascades from `auth.users`; those go with the auth user as before.
- Retries foreign-key failures for up to 5 passes and sweeps again after delete triggers.
- Returns `{deleted, retained, errors, passes}`. The edge function deletes the auth user only when `errors` is empty.
- SECURITY DEFINER, `service_role` only. Tested on a throwaway Postgres: `scripts/ci/sql-tests/run-erase-user-data-test.sh` (CI: `SQL-ERASE-USER-DATA.yml`).

## Command Hub Overview attention state — `ops_attention_state` (VTID-04876, 2026-10-04) — NOT YET APPLIED

Migration `supabase/migrations/20261004130000_vtid_04876_ops_attention_state.sql`.
Time-based hysteresis for `GET /api/v1/ops/attention` (Command Hub Overview,
plan A Phase 1) for attention candidates whose source has no timestamp of its
own. Written only by the gateway (`services/ops-attention.ts` via
`services/ops-attention-reads.ts`, service role). RLS on with no client
policies: service role only. Idempotent (`IF NOT EXISTS`).

| Column | Type | Notes |
|---|---|---|
| `env` | text | PK part. `production` or `staging` (VITANA_ENV); CHECK constrained |
| `fingerprint` | text | PK part. `<env>:<source>:<entity key>` |
| `first_seen` | timestamptz | kept while observed; reset after 90 s unseen |
| `last_seen` | timestamptz | latest observation |

Index: `(env, last_seen)`. Staging writes `env='staging'` rows (owner
decision 2026-10-04). A failed read or write never fails the response: the
request falls back to "first seen at this request" and the response's
`attention_state` source reports it. Rows unseen for more than a day carry
no meaning and may be deleted.
