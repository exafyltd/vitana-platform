# VTID-01212 — Operator Console: Deployment History UX Upgrade

**VTID:** 01212
**Title:** Upgrade Deployment History to Operator-Grade Governance Ledger
**Owner:** Claude (Worker)
**Validator:** Claude (Validator)
**Creativity:** LOW (Existing UI patterns; follow them strictly)
**Type:** Frontend + Backend API (Gateway aggregation)
**Priority:** P1 - HIGH (Operator decision surface; governance visibility)

---

## 0) EXECUTIVE SUMMARY

### Current State
The Deployment History table displays basic deployment info (VTID, Service, SWV, Status, Timestamp) but lacks:
- **Provenance**: Who/what triggered the deployment (Autopilot vs Manual vs CI)
- **Validation Evidence**: Whether the deployment passed validator checks
- **Governance Status**: Whether governance controls approved execution
- **Pipeline Stage Evidence**: PLANNER → WORKER → VALIDATOR → DEPLOY stages
- **Drill-down Capability**: No way to inspect underlying events

### Impact
- Operators cannot distinguish trusted deployments from governance bypasses
- "SUCCESS" status masks missing VTID or skipped validation
- No audit trail for deployment decisions
- Hours wasted investigating deployment provenance manually

### Solution
Upgrade Deployment History with:
1. **Enriched table** with 6 scannable columns + composite health indicator
2. **Detail drawer** with full evidence and raw events
3. **Filtering and search** for quick triage
4. **Visual flagging** of non-compliant deployments

---

## 1) UX DESIGN PRINCIPLES (Locked)

### 1.1 Information Hierarchy

| Priority | Information | Display Location |
|----------|-------------|------------------|
| P0 | VTID, Service, Outcome, Timestamp | Table (always visible) |
| P1 | Trigger Source, Triggered By | Table (scannable) |
| P2 | Health Indicator (composite) | Table (single column) |
| P3 | Validation, Governance, Pipeline | Detail drawer |
| P4 | Raw events, PR links | Detail drawer (collapsed) |

### 1.2 Core UX Rules

1. **Maximum 6-7 table columns** — Operator must scan in <2 seconds
2. **Single composite health indicator** — Replaces 3 separate badge columns
3. **Progressive disclosure** — Summary in table, details on click
4. **Warnings are prominent** — Non-compliant rows cannot appear "clean green"
5. **Actionable drilling** — Every click reveals more context, not dead ends

---

## 2) TABLE DESIGN

### 2.1 Column Layout (6 Columns)

| # | Column | Width | Content | Interaction |
|---|--------|-------|---------|-------------|
| 1 | **Health** | 40px | Composite icon: ✓ ⚠ ✗ | Tooltip shows breakdown |
| 2 | **VTID** | 100px | `VTID-01208` or `—` | Link-like, opens drawer |
| 3 | **Service** | 120px | `gateway`, `worker-runner` | Plain text |
| 4 | **Trigger** | 90px | Badge: AUTOPILOT / MANUAL / CI | Color-coded |
| 5 | **Outcome** | 90px | Badge: SUCCESS / FAILED / ROLLED_BACK | Color-coded |
| 6 | **Timestamp** | 140px | `Jan 23, 18:10` | Local time, sortable |

**Removed from table** (moved to drawer):
- Deploy ID / SWV (available in drawer)
- Triggered By (available in drawer + tooltip)
- Validation (in Health composite)
- Governance (in Health composite)
- Pipeline stages (in drawer)

### 2.2 Health Indicator Logic

The **Health** column shows a single icon representing composite compliance:

```
TRUSTED (green ✓):
  - VTID present (or explicit exception)
  - Validation = PASSED
  - Governance = APPROVED
  - Outcome = SUCCESS

WARNING (yellow ⚠):
  - Missing VTID, OR
  - Validation = SKIPPED/UNKNOWN, OR
  - Governance = UNKNOWN
  - But Outcome = SUCCESS

FAILED (red ✗):
  - Validation = FAILED, OR
  - Governance = BLOCKED, OR
  - Outcome = FAILED/ROLLED_BACK

UNKNOWN (gray ?):
  - Insufficient evidence to determine
```

**Tooltip on hover** shows breakdown:
```
VTID: ✓ Present (VTID-01208)
Validation: ✓ PASSED
Governance: ✓ APPROVED
Pipeline: PL✓ WO✓ VA✓ DE✓
```

### 2.3 Visual Rules

**Row Styling:**
```css
/* Trusted deployment - clean appearance */
.row-trusted { background: transparent; }

/* Warning deployment - subtle highlight */
.row-warning {
  background: rgba(234, 179, 8, 0.08);
  border-left: 3px solid #eab308;
}

/* Failed deployment - attention required */
.row-failed {
  background: rgba(239, 68, 68, 0.08);
  border-left: 3px solid #ef4444;
}
```

**Badge Colors:**
```css
/* Trigger Source */
.badge-autopilot { background: rgba(139, 92, 246, 0.15); color: #a78bfa; }
.badge-manual { background: rgba(59, 130, 246, 0.15); color: #60a5fa; }
.badge-ci { background: rgba(34, 197, 94, 0.15); color: #4ade80; }

/* Outcome */
.badge-success { background: rgba(16, 185, 129, 0.15); color: #34d399; }
.badge-failed { background: rgba(239, 68, 68, 0.15); color: #f87171; }
.badge-rolled-back { background: rgba(249, 115, 22, 0.15); color: #fb923c; }
```

---

## 3) DETAIL DRAWER DESIGN

### 3.1 Drawer Structure

When a row is clicked, a right-side drawer slides in (width: 420px) with:

```
┌──────────────────────────────────────────────┐
│ [←] Deployment Detail               [✕ Close]│
├──────────────────────────────────────────────┤
│                                              │
│ ┌──────────────────────────────────────────┐ │
│ │ VTID-01208                    SUCCESS ✓  │ │
│ │ gateway · SWV-0306 · Jan 23, 18:10       │ │
│ └──────────────────────────────────────────┘ │
│                                              │
│ ▼ PROVENANCE                                 │
│ ┌──────────────────────────────────────────┐ │
│ │ Trigger:     MANUAL                      │ │
│ │ Triggered By: dragan@exafy.com           │ │
│ │ Environment:  dev-sandbox                │ │
│ │ Source:       operator.console.chat      │ │
│ └──────────────────────────────────────────┘ │
│                                              │
│ ▼ VALIDATION & GOVERNANCE                    │
│ ┌──────────────────────────────────────────┐ │
│ │ Validation:  ✓ PASSED                    │ │
│ │ Governance:  ✓ APPROVED (L1)             │ │
│ │ Evidence:    autopilot.validation.passed │ │
│ │              @ 2026-01-23T18:09:45Z      │ │
│ └──────────────────────────────────────────┘ │
│                                              │
│ ▼ PIPELINE STAGES                            │
│ ┌──────────────────────────────────────────┐ │
│ │ PLANNER  ✓  Started 18:08  Done 18:08    │ │
│ │ WORKER   ✓  Started 18:08  Done 18:09    │ │
│ │ VALIDATOR✓  Started 18:09  Done 18:09    │ │
│ │ DEPLOY   ✓  Started 18:10  Done 18:10    │ │
│ └──────────────────────────────────────────┘ │
│                                              │
│ ▶ RAW EVENTS (20)                [Expand ▼] │
│                                              │
│ ▶ RELATED LINKS                  [Expand ▼] │
│   PR #359 · Commit abc123 · Workflow #456   │
│                                              │
└──────────────────────────────────────────────┘
```

### 3.2 Drawer Sections

**Section 1: Header (Always Visible)**
- VTID (large, monospace) or "No VTID" warning
- Service + SWV + Timestamp
- Outcome badge

**Section 2: Provenance (Expanded by Default)**
- Trigger Source badge
- Triggered By (full identifier)
- Environment
- Source (where request originated)

**Section 3: Validation & Governance (Expanded by Default)**
- Validation status with evidence topic
- Governance status with level (L1-L4)
- Link to validation event if available

**Section 4: Pipeline Stages (Expanded by Default)**
- Visual timeline: PLANNER → WORKER → VALIDATOR → DEPLOY
- Each stage shows: status icon, start time, end time
- Missing stages show "—" (not fake "passed")

**Section 5: Raw Events (Collapsed by Default)**
- Last 20 OASIS events for this VTID
- Filtered by deploy/validator topics
- Each event: timestamp, topic, status, message preview
- Click to expand full event JSON

**Section 6: Related Links (Collapsed by Default)**
- PR link (if pr_number present)
- Commit link (if merge_sha present)
- Workflow link (if workflow_run_id present)

### 3.3 Drawer Interactions

- **ESC key**: Closes drawer
- **Click outside**: Closes drawer
- **↑↓ keys** (when drawer open): Navigate to prev/next deployment
- **Section headers**: Click to expand/collapse

---

## 4) FILTERING & SEARCH

### 4.1 Filter Bar (Above Table)

```
┌──────────────────────────────────────────────────────────────┐
│ [🔍 Search VTID, service...]  [Health ▼] [Trigger ▼] [Date ▼]│
└──────────────────────────────────────────────────────────────┘
```

**Search Box:**
- Searches: VTID, Service, SWV, Triggered By
- Debounced (300ms)
- Shows "No results" state

**Health Filter (Multi-select):**
- [ ] Trusted (green)
- [ ] Warning (yellow)
- [ ] Failed (red)
- Default: All selected

**Trigger Filter (Multi-select):**
- [ ] AUTOPILOT
- [ ] MANUAL
- [ ] CI
- Default: All selected

**Date Filter:**
- Last 24 hours (default)
- Last 7 days
- Last 30 days
- Custom range

### 4.2 Filter Persistence

- Filters persist in URL query params: `?health=warning,failed&trigger=manual&days=7`
- Allows sharing filtered views with teammates
- Reset button clears all filters

---

## 5) KEYBOARD NAVIGATION

| Key | Action |
|-----|--------|
| `↓` / `j` | Select next row |
| `↑` / `k` | Select previous row |
| `Enter` | Open detail drawer |
| `Escape` | Close detail drawer |
| `/` | Focus search box |
| `r` | Refresh table |
| `?` | Show keyboard shortcuts |

---

## 6) BACKEND API

### 6.1 New Endpoint

**Path:** `GET /api/v1/operator/deployments/history`

This is a **new endpoint** (not modifying existing `/api/v1/operator/deployments`) to maintain backwards compatibility.

**Query Parameters:**
| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `limit` | int | 50 | Max 200 |
| `cursor` | string | null | Pagination cursor |
| `health` | string | null | Comma-separated: `trusted,warning,failed` |
| `trigger` | string | null | Comma-separated: `AUTOPILOT,MANUAL,CI` |
| `search` | string | null | Search term |
| `days` | int | 7 | Time window in days |

**Response:**
```json
{
  "ok": true,
  "items": [
    {
      "deploy_id": "SWV-0306",
      "service": "gateway",
      "timestamp": "2026-01-23T18:10:30Z",
      "outcome": "success",

      "vtid": "VTID-01208",
      "env": "dev-sandbox",

      "trigger_source": "MANUAL",
      "triggered_by": "dragan@exafy.com",

      "validation_status": "PASSED",
      "governance_status": "APPROVED",
      "governance_level": "L1",

      "health": "trusted",

      "pipeline": {
        "planner": { "status": "passed", "started_at": "...", "completed_at": "..." },
        "worker": { "status": "passed", "started_at": "...", "completed_at": "..." },
        "validator": { "status": "passed", "started_at": "...", "completed_at": "..." },
        "deploy": { "status": "passed", "started_at": "...", "completed_at": "..." }
      },

      "evidence": {
        "oasis_event_ids": ["uuid-1", "uuid-2"],
        "pr_number": 359,
        "merge_sha": "abc123def456",
        "workflow_run_id": 12345,
        "deploy_topic": "cicd.deploy.service.succeeded",
        "validation_topic": "autopilot.validation.passed"
      }
    }
  ],
  "next_cursor": "eyJ0cyI6IjIwMjYtMDEtMjNUMTg6MDA6MDBaIn0=",
  "total_count": 156
}
```

### 6.2 Detail Endpoint

**Path:** `GET /api/v1/operator/deployments/history/:deployId/events`

Returns raw OASIS events for the deployment.

**Query Parameters:**
| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `limit` | int | 20 | Max events to return |

**Response:**
```json
{
  "ok": true,
  "events": [
    {
      "id": "uuid",
      "created_at": "2026-01-23T18:10:30Z",
      "topic": "cicd.deploy.service.succeeded",
      "status": "success",
      "message": "Deployed gateway to dev-sandbox",
      "metadata": { ... }
    }
  ]
}
```

### 6.3 Evidence Derivation Rules (Backend Logic)

**`vtid` derivation:**
```
1. Check deploy event metadata.vtid
2. If null, check oasis_events WHERE topic='cicd.deploy.version.recorded' AND metadata->>'swv_id'=deploy_id
3. If null, check vtid_ledger correlation by timestamp window (±5 min)
4. If still null → vtid = null
```

**`trigger_source` derivation:**
```
1. If metadata contains autopilot_run_id → "AUTOPILOT"
2. If topic matches 'autopilot.*' pattern → "AUTOPILOT"
3. If initiator='agent' AND source contains 'github' → "CI"
4. If initiator='user' OR source='operator.console.chat' → "MANUAL"
5. Else → "UNKNOWN"
```

**`triggered_by` derivation:**
```
1. For MANUAL: metadata.actor OR metadata.email OR software_versions.initiator
2. For AUTOPILOT: metadata.autopilot_run_id OR metadata.worker_id
3. For CI: metadata.github_actor OR 'GitHub Actions'
4. Else → "unknown"
```

**`validation_status` derivation:**
```
1. Query oasis_events WHERE vtid=:vtid AND topic LIKE 'autopilot.validation.%'
   ORDER BY created_at DESC LIMIT 1
2. If topic='autopilot.validation.passed' → "PASSED"
3. If topic='autopilot.validation.failed' → "FAILED"
4. If topic='autopilot.validation.skipped' → "SKIPPED"
5. Else → "UNKNOWN"
```

**`governance_status` derivation:**
```
1. Query oasis_events WHERE vtid=:vtid AND topic LIKE 'governance.deploy.%'
   ORDER BY created_at DESC LIMIT 1
2. If topic='governance.deploy.allowed' → "APPROVED"
3. If topic='governance.deploy.blocked' → "BLOCKED"
4. If validation_status='PASSED' AND no blocking events → "APPROVED" (implicit)
5. Else → "UNKNOWN"
```

**`health` composite derivation:**
```
function deriveHealth(row):
  if row.outcome == 'failed' or row.outcome == 'rolled_back':
    return 'failed'
  if row.validation_status == 'FAILED' or row.governance_status == 'BLOCKED':
    return 'failed'
  if row.vtid == null:
    return 'warning'
  if row.validation_status in ['SKIPPED', 'UNKNOWN']:
    return 'warning'
  if row.governance_status == 'UNKNOWN':
    return 'warning'
  if row.validation_status == 'PASSED' and row.governance_status == 'APPROVED':
    return 'trusted'
  return 'warning'
```

**`pipeline` stage derivation:**
```
For each stage in [PLANNER, WORKER, VALIDATOR, DEPLOY]:
  1. Query oasis_events WHERE vtid=:vtid AND topic matches stage pattern
  2. If success event exists → status='passed', extract timestamps
  3. If error event exists → status='failed'
  4. If no events → status='unknown'
```

---

## 7) FILES TO CREATE/MODIFY

### New Files

| File | Purpose |
|------|---------|
| `services/gateway/src/routes/deployment-history.ts` | New API endpoint |
| `services/gateway/src/services/deployment-history-service.ts` | Aggregation logic |

### Files to Modify

| File | Change |
|------|--------|
| `services/gateway/src/index.ts` | Mount new routes |
| `services/gateway/src/frontend/command-hub/app.js` | UI implementation |
| `services/gateway/src/frontend/command-hub/styles.css` | Drawer + filter styles |

---

## 8) CONSTRAINTS

| Constraint | Requirement |
|------------|-------------|
| **CSP Compliance** | No inline styles, no inline scripts, no CDN assets |
| **Additive Only** | Do not modify existing `/api/v1/operator/deployments` endpoint |
| **No Regressions** | Chat, Live Ticker tabs must continue working |
| **Read-Only** | No mutations allowed from this UI |
| **Performance** | Initial load <500ms, drawer open <200ms |

---

## 9) TEST PLAN

### 9.1 Unit Tests (Backend)

| Test | Assertion |
|------|-----------|
| `deriveHealth()` returns `trusted` | VTID present + validation PASSED + governance APPROVED |
| `deriveHealth()` returns `warning` | Missing VTID |
| `deriveHealth()` returns `warning` | Validation SKIPPED |
| `deriveHealth()` returns `failed` | Outcome is FAILED |
| `deriveTriggerSource()` returns `AUTOPILOT` | autopilot_run_id in metadata |
| `deriveTriggerSource()` returns `MANUAL` | initiator=user |
| Pagination cursor works | Returns correct next page |
| Filter by health works | Only returns matching rows |

### 9.2 Integration Tests (API)

| Test | Assertion |
|------|-----------|
| `GET /deployments/history` returns 200 | Response matches schema |
| Limit parameter caps at 200 | Request with limit=500 returns max 200 |
| Cursor pagination works | Second page returns different rows |
| Combined filters work | health=warning&trigger=MANUAL returns intersection |

### 9.3 E2E Tests (UI)

| Test | Assertion |
|------|-----------|
| Table renders with 6 columns | Column headers match spec |
| Health icon shows correct state | Trusted=green, warning=yellow, failed=red |
| Row click opens drawer | Drawer slides in from right |
| Drawer shows all sections | Provenance, Validation, Pipeline, Events |
| ESC closes drawer | Drawer slides out |
| Filter changes table content | Rows update after filter selection |
| Search filters by VTID | Typing "01208" shows matching row |
| Keyboard navigation works | ↓ selects next row |
| Warning row has visual indicator | Yellow left border visible |

### 9.4 Manual Verification

| Scenario | Check |
|----------|-------|
| Deploy via Operator Chat | Row appears with MANUAL trigger |
| Autopilot deploy (if available) | Row appears with AUTOPILOT trigger |
| CI deploy via safe-merge | Row appears with CI trigger |
| Deploy without VTID | Warning indicator visible |
| Deploy with failed validation | Red health icon |

---

## 10) SUCCESS CRITERIA

- [ ] Table displays 6 columns with correct layout
- [ ] Health indicator shows composite status correctly
- [ ] Warning rows have yellow left border
- [ ] Failed rows have red left border
- [ ] Row click opens detail drawer
- [ ] Drawer shows Provenance section
- [ ] Drawer shows Validation & Governance section
- [ ] Drawer shows Pipeline stages with timestamps
- [ ] Drawer shows raw events (collapsed)
- [ ] Filter bar filters table content
- [ ] Search works for VTID and service
- [ ] Keyboard navigation works (↓↑ Enter ESC)
- [ ] No console errors
- [ ] CSP compliant (no inline styles/scripts)
- [ ] Existing tabs (Chat, Live Ticker) still work
- [ ] Performance: <500ms initial load

---

## 11) OPERATOR DECISION FRAMEWORK

This section defines what operators should DO based on deployment health:

### When Health = TRUSTED (green ✓)
- **Action**: No action required
- **Meaning**: Deployment followed governance, passed validation
- **Next Step**: Continue monitoring

### When Health = WARNING (yellow ⚠)
- **Action**: Investigate before relying on deployment
- **Possible Issues**:
  - Missing VTID → Check if deliberate (hotfix) or accidental bypass
  - Validation SKIPPED → Verify skip was authorized
  - Governance UNKNOWN → Check if governance was evaluated
- **Next Step**: Open drawer, review evidence, decide if acceptable

### When Health = FAILED (red ✗)
- **Action**: Immediate attention required
- **Possible Issues**:
  - Deployment failed → Check logs, may need rollback
  - Validation failed → Deployment should not have proceeded
  - Governance blocked → Bypass detected
- **Next Step**: Open drawer, review failure reason, escalate if governance bypass

---

## 12) VISUAL REFERENCE

### 12.1 Table View (Default)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ Deployment History                                            [🔄 Refresh]  │
├─────────────────────────────────────────────────────────────────────────────┤
│ [🔍 Search...]  [Health: All ▼] [Trigger: All ▼] [Last 7 days ▼]           │
├─────────────────────────────────────────────────────────────────────────────┤
│ Health │ VTID        │ Service     │ Trigger   │ Outcome  │ Timestamp      │
├────────┼─────────────┼─────────────┼───────────┼──────────┼────────────────┤
│   ✓    │ VTID-01208  │ gateway     │ MANUAL    │ SUCCESS  │ Jan 23, 18:10  │
│   ⚠    │ —           │ worker      │ CI        │ SUCCESS  │ Jan 23, 17:45  │
│   ✗    │ VTID-01205  │ gateway     │ AUTOPILOT │ FAILED   │ Jan 23, 16:30  │
│   ✓    │ VTID-01200  │ oasis-op    │ MANUAL    │ SUCCESS  │ Jan 23, 14:00  │
└────────┴─────────────┴─────────────┴───────────┴──────────┴────────────────┘
```

### 12.2 Warning Row Highlight

```
├────────┼─────────────┼─────────────┼───────────┼──────────┼────────────────┤
│ ▌  ⚠   │ —           │ worker      │ CI        │ SUCCESS  │ Jan 23, 17:45  │
  ↑
  Yellow border indicating non-governed deployment
```

### 12.3 Health Tooltip

```
┌─────────────────────────┐
│ Deployment Health       │
├─────────────────────────┤
│ VTID:       ✓ Present   │
│ Validation: ✓ PASSED    │
│ Governance: ✓ APPROVED  │
│ Pipeline:   4/4 stages  │
│─────────────────────────│
│ Status: TRUSTED         │
└─────────────────────────┘
```

---

## 13) IMPLEMENTATION ORDER

1. **Phase 1: Backend API** (estimate: 1 task)
   - Create `/api/v1/operator/deployments/history` endpoint
   - Implement evidence derivation rules
   - Add pagination and filtering

2. **Phase 2: Table UI** (estimate: 1 task)
   - Update table columns (6 columns)
   - Implement health indicator
   - Add row styling for warning/failed

3. **Phase 3: Detail Drawer** (estimate: 1 task)
   - Build drawer component
   - Implement all sections
   - Add expand/collapse behavior

4. **Phase 4: Filtering & Search** (estimate: 1 task)
   - Add filter bar
   - Implement search
   - Add URL persistence

5. **Phase 5: Polish** (estimate: 1 task)
   - Keyboard navigation
   - Performance optimization
   - Accessibility review

---

## 14) ACCEPTANCE CHECKLIST

- [ ] **Backend**: New endpoint returns enriched rows with deterministic derivation
- [ ] **Table**: 6 columns displayed correctly
- [ ] **Health**: Composite indicator shows correct state
- [ ] **Visual**: Warning/failed rows visually distinct
- [ ] **Drawer**: Opens on row click with all sections
- [ ] **Events**: Raw events shown in drawer
- [ ] **Filter**: Health, trigger, date filters work
- [ ] **Search**: VTID and service searchable
- [ ] **Keyboard**: Navigation shortcuts work
- [ ] **CSP**: No inline styles or scripts
- [ ] **Compat**: Chat and Live Ticker tabs unaffected
- [ ] **Perf**: <500ms initial load

---

## APPENDIX A: Comparison with Original Spec

| Aspect | Original Spec | This Spec (Improved) |
|--------|---------------|----------------------|
| Table columns | 10 columns | 6 columns + drawer |
| Badge fatigue | 6 badge columns | 1 composite + 2 badges |
| Filtering | Not specified | Full filter bar |
| Search | Not specified | Search box |
| Keyboard nav | Not specified | Full keyboard support |
| Decision framework | Implicit | Explicit operator guidance |
| URL persistence | Not specified | Filter state in URL |
| Performance targets | Not specified | <500ms, <200ms |
| Progressive disclosure | Partial | Full (collapsed sections) |

---

## APPENDIX B: Future Enhancements (Out of Scope)

- Export to CSV/JSON for audit reports
- Comparison view (diff two deployments)
- Deployment timeline visualization
- Slack/email alerts for warning/failed deployments
- Deployment rollback action (read-only constraint)
