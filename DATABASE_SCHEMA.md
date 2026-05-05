# Vitana Platform Database Schema
**CANONICAL REFERENCE - Last Updated: 2026-05-10**

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
| 2026-05-10 | Added release_components, release_history, release_backlog_items tables for the release backlog & versioning system (R1+R3 of Phase 2 plan) | Claude | claude/backlog-versioning-structure-7frZn |

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

## Release Backlog & Versioning (R1+R3 of Phase 2 plan)

### release_components
**Purpose:** Catalog: one row per shippable thing we version. Covers BOTH platform components (`owner='platform'`, `tenant_id NULL`) and tenant-app surfaces (`owner='tenant'`, `tenant_id NOT NULL`). For tenant rows, `min_platform_version` and `target_platform_version` refer specifically to the `platform.sdk` version per design decision P2.
**Used by:** `services/gateway/src/routes/releases.ts`, Command Hub `/dev/releases`, MAXINA `/admin/releases` (Overview tab).
**Migration:** `supabase/migrations/20260510000000_release_backlog_v1.sql`

**Schema:**
```sql
CREATE TABLE release_components (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug                     TEXT NOT NULL UNIQUE,                  -- e.g. 'platform.sdk', 'tenant.maxina.ios'
  display_name             TEXT NOT NULL,
  owner                    TEXT NOT NULL CHECK (owner IN ('platform','tenant')),
  tenant_id                UUID,                                  -- NULL when owner='platform'
  surface                  TEXT NOT NULL CHECK (surface IN
                             ('command_hub','web','api','sdk','desktop','ios','android')),
  repo                     TEXT,
  current_version          TEXT,                                  -- semver
  current_channel          TEXT CHECK (current_channel IN ('internal','beta','stable')),
  current_released_at      TIMESTAMPTZ,
  current_release_id       UUID REFERENCES release_history(id) ON DELETE SET NULL,
  min_platform_version     TEXT,                                  -- pin against platform.sdk (P2)
  target_platform_version  TEXT,                                  -- pin against platform.sdk (P2)
  public_changelog         BOOLEAN NOT NULL DEFAULT FALSE,        -- P4: surface-derived defaults via seed
  enabled                  BOOLEAN NOT NULL DEFAULT TRUE,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT release_components_tenant_id_required_for_tenant_owner
    CHECK ((owner='tenant' AND tenant_id IS NOT NULL) OR (owner='platform' AND tenant_id IS NULL))
);
CREATE INDEX idx_release_components_owner_tenant ON release_components(owner, tenant_id);
CREATE INDEX idx_release_components_surface ON release_components(surface);
```

**Seed (in migration):** four platform components (`platform.command-hub`, `platform.api`, `platform.sdk`, `platform.web`) with `public_changelog` defaults per P4 (web=TRUE, others=FALSE). Tenant rows for MAXINA Desktop/iOS/Android added in a follow-up migration once the canonical `tenants.id` is confirmed.

**API Endpoints:**
- `GET /api/v1/releases/overview` - Role-aware matrix payload (Phase 2)
- `GET /api/v1/releases/components` - List with filters (Phase 4 - R9)
- `GET /api/v1/releases/components/:id` - Detail incl. last 10 history rows (Phase 4 - R9)
- `POST /api/v1/releases/components` - Register new component (Phase 4 - R9)
- `PATCH /api/v1/releases/components/:id` - Update fields except channel (Phase 4 - R9)
- `POST /api/v1/releases/components/:id/promote` - Channel promotion per P3 (Phase 4 - R9)

---

### release_history
**Purpose:** Append-only log of every release event for a component. The `changelog` column is what tenant_admin authors via `/admin/releases/changelog` and what `/api/v1/releases/changelog/public` serves to App Store / Play Store / in-app `/changelog` for stable releases (per P4 + P5).
**Used by:** `services/gateway/src/routes/releases.ts`, the planned `services/release-publisher` worker (P5).
**Migration:** `supabase/migrations/20260510000000_release_backlog_v1.sql`

**Schema:**
```sql
CREATE TABLE release_history (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  component_id    UUID NOT NULL REFERENCES release_components(id) ON DELETE CASCADE,
  version         TEXT NOT NULL,
  channel         TEXT NOT NULL CHECK (channel IN ('internal','beta','stable')),
  released_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  released_by     UUID,
  changelog       TEXT,                  -- markdown; published when channel='stable' AND public_changelog=TRUE
  internal_notes  TEXT,                  -- never exposed via /changelog/public
  artifact_url    TEXT,
  commit_sha      TEXT,
  rollback_of     UUID REFERENCES release_history(id),
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_release_history_component_released ON release_history(component_id, released_at DESC);
CREATE INDEX idx_release_history_channel ON release_history(channel, released_at DESC);
```

**API Endpoints:**
- `GET /api/v1/releases/history` - Filterable list (Phase 4 - R9)
- `POST /api/v1/releases/history` - Record a release (Phase 4 - R9; atomic with release_components.current_*)
- `GET /api/v1/releases/changelog/public` - Public stable-channel changelog, no auth (Phase 5 - R17)

**OASIS Events** (Phase 6 - R19):
- `release.published` - First publish on a channel
- `release.promoted` - Channel transition (per P3)
- `release.rolled_back` - With `rollback_of` reference
- `release.changelog.published` - Tenant_admin promotes draft to stable (triggers publisher worker)
- `release.publish.attempted` - Worker handler attempts external push
- `release.publish.failed` - After retry exhaustion

---

### release_backlog_items
**Purpose:** Pending work targeting a future release. Two backlog audiences: tenant_admin's release work (App Store screenshots, public changelog copy, version planning) and developer execution work. Per P1, the `vtid` column is OPTIONAL — when set, the API returns `vtid_ledger.status` as the effective status (read-through) and rejects writes to the local `status` field.
**Used by:** `services/gateway/src/routes/releases.ts`, MAXINA `/admin/releases` (Backlog tab), Command Hub `/dev/releases` (drawer).
**Migration:** `supabase/migrations/20260510000000_release_backlog_v1.sql`

**Schema:**
```sql
CREATE TABLE release_backlog_items (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  component_id    UUID NOT NULL REFERENCES release_components(id) ON DELETE CASCADE,
  title           TEXT NOT NULL,
  summary         TEXT,
  vtid            TEXT,                                  -- optional → vtid_ledger.vtid (P1)
  status          TEXT NOT NULL CHECK (status IN
                    ('proposed','planned','in_progress','blocked','done','dropped')),
  target_version  TEXT,
  target_channel  TEXT CHECK (target_channel IN ('internal','beta','stable')),
  visibility      TEXT NOT NULL DEFAULT 'internal'
                  CHECK (visibility IN ('internal','tenant','public')),
  priority        INT NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_release_backlog_component_status ON release_backlog_items(component_id, status);
CREATE INDEX idx_release_backlog_vtid ON release_backlog_items(vtid) WHERE vtid IS NOT NULL;
```

**API Endpoints:**
- `GET /api/v1/releases/backlog` - List with role-aware visibility filtering (Phase 4 - R9)
- `POST /api/v1/releases/backlog` - Create item (Phase 4 - R9)
- `PATCH /api/v1/releases/backlog/:id` - Update; rejects status writes when vtid IS NOT NULL (P1, R12)
- `DELETE /api/v1/releases/backlog/:id` - Drop item (Phase 4 - R9)

**Read-through status (P1):**
- When `vtid IS NULL` → API returns `local.status`
- When `vtid IS NOT NULL` → API returns `vtid_ledger.status` as `effective_status` (joined server-side)
- Writes to `status` for VTID-linked items return `409 Conflict`

**OASIS Events** (Phase 6 - R19):
- `release.backlog.item.created`
- `release.backlog.item.updated`
- `release.backlog.item.dropped`

---

**Remember:** This file is the SINGLE SOURCE OF TRUTH for table names.
When in doubt, CHECK HERE FIRST!
