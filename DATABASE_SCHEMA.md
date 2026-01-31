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

**Remember:** This file is the SINGLE SOURCE OF TRUTH for table names.
When in doubt, CHECK HERE FIRST! 🎯
