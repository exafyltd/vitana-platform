# Self-Healing System — Test Plan

**Date**: 2026-04-02  
**Purpose**: Prove the autonomous self-healing pipeline works end-to-end before production use.

---

## Pre-Deployment Checks (Local)

### T-01: TypeScript Compilation

```bash
cd services/gateway && npx tsc --noEmit 2>&1 | grep "self-healing\|self_healing"
```

**Pass criteria**: Zero errors. **Status**: PASSED (verified 2026-04-02).

### T-02: Import Chain Verification

```bash
grep -n "self-healing" services/gateway/src/index.ts
```

**Pass criteria**: Import line + `mountRouterSync` line both present.

---

## Layer 1: Database Migration

### T-03: Run Migration

Execute `supabase/migrations/20260402000000_self_healing_tables.sql` in Supabase SQL Editor.

### T-04: Verify Tables

```sql
SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public'
AND table_name IN ('self_healing_log', 'self_healing_snapshots', 'system_config');
```

**Pass criteria**: 3 rows returned.

### T-05: Verify Default Config

```sql
SELECT * FROM system_config WHERE key LIKE 'self_healing%';
```

**Pass criteria**: `self_healing_enabled = true`, `self_healing_autonomy_level = 3`.

---

## Layer 2: Smoke Tests (Post-Deploy)

### T-06: Health Endpoint

```bash
curl -s https://gateway-q74ibpv6ia-uc.a.run.app/api/v1/self-healing/health | jq .
```

**Pass criteria**: `{ "ok": true, "service": "self-healing" }`

### T-07: Config Endpoint

```bash
curl -s https://gateway-q74ibpv6ia-uc.a.run.app/api/v1/self-healing/config | jq .
```

**Pass criteria**: `{ "ok": true, "enabled": true, "autonomy_level": 3, "autonomy_name": "AUTO_FIX_SIMPLE" }`

### T-08: Active Tasks (Empty)

```bash
curl -s https://gateway-q74ibpv6ia-uc.a.run.app/api/v1/self-healing/active | jq .
```

**Pass criteria**: `{ "ok": true, "tasks": [] }`

### T-09: History (Empty)

```bash
curl -s "https://gateway-q74ibpv6ia-uc.a.run.app/api/v1/self-healing/history?limit=5" | jq .
```

**Pass criteria**: `{ "ok": true, "items": [], "total": 0 }`

### T-10: Invalid Report Rejected

```bash
curl -s -X POST https://gateway-q74ibpv6ia-uc.a.run.app/api/v1/self-healing/report \
  -H "Content-Type: application/json" \
  -d '{"bad":"data"}' | jq .
```

**Pass criteria**: `{ "ok": false, "error": "Invalid report format" }`, HTTP 400.

### T-11: Invalid Kill Switch Rejected

```bash
curl -s -X POST https://gateway-q74ibpv6ia-uc.a.run.app/api/v1/self-healing/kill-switch \
  -H "Content-Type: application/json" \
  -d '{"action":"invalid"}' | jq .
```

**Pass criteria**: `{ "ok": false, "error": "action must be \"activate\" or \"deactivate\"" }`

### T-12: Invalid Autonomy Level Rejected

```bash
curl -s -X PATCH https://gateway-q74ibpv6ia-uc.a.run.app/api/v1/self-healing/config \
  -H "Content-Type: application/json" \
  -d '{"autonomy_level": 99}' | jq .
```

**Pass criteria**: `{ "ok": false, "error": "autonomy_level must be 0-4" }`

---

## Layer 3: Kill Switch & Config

### T-13: Activate Kill Switch

```bash
curl -s -X POST https://gateway-q74ibpv6ia-uc.a.run.app/api/v1/self-healing/kill-switch \
  -H "Content-Type: application/json" \
  -d '{"action":"activate","operator":"test-engineer","reason":"Testing kill switch"}' | jq .
```

**Pass criteria**: `{ "ok": true, "status": "killed", "enabled": false }`

### T-14: Config Reflects Kill Switch

```bash
curl -s https://gateway-q74ibpv6ia-uc.a.run.app/api/v1/self-healing/config | jq .enabled
```

**Pass criteria**: `false`

### T-15: Report Blocked When Killed

```bash
curl -s -X POST https://gateway-q74ibpv6ia-uc.a.run.app/api/v1/self-healing/report \
  -H "Content-Type: application/json" \
  -d '{
    "timestamp": "2026-04-02T12:00:00Z", "total": 2, "live": 1,
    "services": [
      {"name":"Gateway","endpoint":"/health","status":"live","http_status":200,"response_body":"","response_time_ms":50,"error_message":null},
      {"name":"TestSvc","endpoint":"/api/v1/test/health","status":"down","http_status":500,"response_body":"error","response_time_ms":30,"error_message":null}
    ]
  }' | jq .
```

**Pass criteria**: `processed: 0`, all details have `action: "disabled"`.

### T-16: Deactivate Kill Switch

```bash
curl -s -X POST https://gateway-q74ibpv6ia-uc.a.run.app/api/v1/self-healing/kill-switch \
  -H "Content-Type: application/json" \
  -d '{"action":"deactivate","operator":"test-engineer"}' | jq .
```

**Pass criteria**: `{ "ok": true, "status": "active", "enabled": true }`

### T-17: Change Autonomy Level

```bash
curl -s -X PATCH https://gateway-q74ibpv6ia-uc.a.run.app/api/v1/self-healing/config \
  -H "Content-Type: application/json" \
  -d '{"autonomy_level": 1, "operator": "test-engineer"}' | jq .
```

**Pass criteria**: `{ "ok": true, "autonomy_level": 1, "autonomy_name": "DIAGNOSE_ONLY" }`

---

## Layer 4: Integration Tests (DIAGNOSE_ONLY Mode)

**Pre-requisite**: Set autonomy to DIAGNOSE_ONLY (level 1) to prevent actual autopilot injection:

```bash
curl -s -X PATCH https://gateway-q74ibpv6ia-uc.a.run.app/api/v1/self-healing/config \
  -H "Content-Type: application/json" \
  -d '{"autonomy_level": 1}' | jq .
```

### T-18: All-Healthy Report (No Action)

```bash
curl -s -X POST https://gateway-q74ibpv6ia-uc.a.run.app/api/v1/self-healing/report \
  -H "Content-Type: application/json" \
  -d '{
    "timestamp": "2026-04-02T12:00:00Z", "total": 2, "live": 2,
    "services": [
      {"name":"Gateway","endpoint":"/health","status":"live","http_status":200,"response_body":"","response_time_ms":50,"error_message":null},
      {"name":"Auth","endpoint":"/api/v1/auth/health","status":"live","http_status":200,"response_body":"","response_time_ms":60,"error_message":null}
    ]
  }' | jq .
```

**Pass criteria**: `processed: 0, vtids_created: 0, details: []`

### T-19: Down Service Triggers Diagnosis + VTID Allocation

```bash
curl -s -X POST https://gateway-q74ibpv6ia-uc.a.run.app/api/v1/self-healing/report \
  -H "Content-Type: application/json" \
  -d '{
    "timestamp": "2026-04-02T12:00:00Z", "total": 2, "live": 1,
    "services": [
      {"name":"Gateway","endpoint":"/health","status":"live","http_status":200,"response_body":"","response_time_ms":50,"error_message":null},
      {"name":"Test Down Service","endpoint":"/api/v1/test-down-001/health","status":"down","http_status":404,"response_body":"Cannot GET /api/v1/test-down-001/health","response_time_ms":30,"error_message":null}
    ]
  }' | jq .
```

**Pass criteria**:
- `vtids_created: 1`
- `details[0].action: "created"`
- `details[0].vtid: "VTID-XXXXX"` (a real VTID number)
- `details[0].reason` contains "Diagnosed only"

**Save the VTID** — you'll need it for T-20 and T-21.

### T-20: Dedup — Same Endpoint Skipped

```bash
curl -s -X POST https://gateway-q74ibpv6ia-uc.a.run.app/api/v1/self-healing/report \
  -H "Content-Type: application/json" \
  -d '{
    "timestamp": "2026-04-02T12:01:00Z", "total": 2, "live": 1,
    "services": [
      {"name":"Gateway","endpoint":"/health","status":"live","http_status":200,"response_body":"","response_time_ms":50,"error_message":null},
      {"name":"Test Down Service","endpoint":"/api/v1/test-down-001/health","status":"down","http_status":404,"response_body":"","response_time_ms":30,"error_message":null}
    ]
  }' | jq .
```

**Pass criteria**: `vtids_created: 0`, `skipped: 1`, reason mentions "Active VTID".

### T-21: VTID Appears in Active Tasks

```bash
curl -s https://gateway-q74ibpv6ia-uc.a.run.app/api/v1/self-healing/active | jq .
```

**Pass criteria**: `tasks` array contains an entry with the VTID from T-19, `metadata.source: "self-healing"`.

### T-22: OASIS Events Emitted

```bash
VTID="VTID-XXXXX"  # from T-19
curl -s "https://gateway-q74ibpv6ia-uc.a.run.app/api/v1/oasis/events?vtid=$VTID" | jq '.[].topic'
```

**Pass criteria**: Events include `self-healing.diagnosis.started` and `self-healing.diagnosis.completed`.

---

## Layer 5: Full Pipeline Test (SPEC_AND_WAIT Mode)

**Pre-requisite**: Set autonomy to SPEC_AND_WAIT (level 2):

```bash
curl -s -X PATCH https://gateway-q74ibpv6ia-uc.a.run.app/api/v1/self-healing/config \
  -H "Content-Type: application/json" \
  -d '{"autonomy_level": 2}' | jq .
```

### T-23: Down Service Triggers Diagnosis + Spec + Injection (Awaiting Approval)

Use a DIFFERENT endpoint than T-19 to avoid dedup:

```bash
curl -s -X POST https://gateway-q74ibpv6ia-uc.a.run.app/api/v1/self-healing/report \
  -H "Content-Type: application/json" \
  -d '{
    "timestamp": "2026-04-02T12:10:00Z", "total": 2, "live": 1,
    "services": [
      {"name":"Gateway","endpoint":"/health","status":"live","http_status":200,"response_body":"","response_time_ms":50,"error_message":null},
      {"name":"Test Pipeline Service","endpoint":"/api/v1/test-pipeline-001/health","status":"down","http_status":500,"response_body":"Internal Server Error","response_time_ms":100,"error_message":null}
    ]
  }' | jq .
```

**Pass criteria**:
- `vtids_created: 1`
- `details[0].action: "created"`
- A VTID is allocated

### T-24: Verify Spec Was Generated

```bash
VTID="VTID-XXXXX"  # from T-23
curl -s "https://gateway-q74ibpv6ia-uc.a.run.app/api/v1/oasis/events?vtid=$VTID" | jq '.[].topic'
```

**Pass criteria**: Events include `self-healing.spec.generated` and `self-healing.task.injected`.

### T-25: Verify Task in Command Hub

```bash
curl -s "https://gateway-q74ibpv6ia-uc.a.run.app/api/v1/vtid/$VTID" | jq '{vtid, title, status, spec_status, metadata}'
```

**Pass criteria**:
- `title` starts with "SELF-HEAL:"
- `status: "pending"`
- `spec_status: "pending_approval"` (because SPEC_AND_WAIT forces approval)
- `metadata.source: "self-healing"`
- `metadata.failure_class` is a valid class

### T-26: History Has Entry

```bash
curl -s "https://gateway-q74ibpv6ia-uc.a.run.app/api/v1/self-healing/history?limit=5" | jq '.items[0]'
```

**Pass criteria**: Entry exists with matching vtid, endpoint, failure_class, confidence, outcome="pending".

---

## Layer 6: Verification & Blast Radius Test

### T-27: Manual Verification (No Fix Deployed — Expect Escalate)

```bash
VTID="VTID-XXXXX"  # from T-23
curl -s -X POST "https://gateway-q74ibpv6ia-uc.a.run.app/api/v1/self-healing/verify/$VTID" \
  --max-time 120 | jq .
```

**NOTE**: This call takes ~35 seconds (30s stabilization wait + health pings).

**Pass criteria**:
- `result.target_endpoint_fixed: false` (no actual fix was deployed)
- `result.blast_radius: "none"` (nothing newly broken)
- `result.action: "escalate"`
- `result.pre_fix_snapshot_id` and `post_fix_snapshot_id` are UUIDs

### T-28: Snapshots Stored

```bash
curl -s "https://gateway-q74ibpv6ia-uc.a.run.app/api/v1/self-healing/snapshots/$VTID" | jq .
```

**Pass criteria**: Both `pre_fix` and `post_fix` objects present, each with `healthy` and `total` counts, `endpoints` array with all 54 endpoints.

### T-29: Manual Rollback

```bash
curl -s -X POST "https://gateway-q74ibpv6ia-uc.a.run.app/api/v1/self-healing/rollback/$VTID" | jq .
```

**Pass criteria**: `{ "ok": true, "message": "Rollback requested for VTID-XXXXX" }`

---

## Layer 7: Dashboard UI

### T-30: Self-Healing Tab Renders

1. Open `https://gateway-q74ibpv6ia-uc.a.run.app/command-hub/infrastructure/self-healing/`
2. Open browser DevTools → Console

**Pass criteria**:
- No JavaScript errors in console
- Status bar shows "Status: ACTIVE" and "Mode: SPEC & WAIT" (or whatever level is set)
- Active Repairs section shows tasks from T-19 and T-23
- History table shows entries
- Kill switch button is visible
- Autonomy level dropdown is functional

### T-31: Kill Switch via UI

1. Click the "KILL SWITCH" button
2. Confirm the dialog

**Pass criteria**:
- Status bar updates to "DISABLED"
- Button text changes to "RE-ENABLE"

3. Click "RE-ENABLE" to restore

---

## Cleanup After Testing

```bash
# Reset autonomy to production level
curl -s -X PATCH https://gateway-q74ibpv6ia-uc.a.run.app/api/v1/self-healing/config \
  -H "Content-Type: application/json" \
  -d '{"autonomy_level": 3, "operator": "test-cleanup"}' | jq .

# Verify
curl -s https://gateway-q74ibpv6ia-uc.a.run.app/api/v1/self-healing/config | jq .
```

---

## Test Summary Checklist

| # | Test | Layer | Status |
|---|------|-------|--------|
| T-01 | TypeScript compilation | Pre-deploy | |
| T-02 | Import chain | Pre-deploy | |
| T-03 | Run migration | Database | |
| T-04 | Tables exist | Database | |
| T-05 | Default config | Database | |
| T-06 | Health endpoint | Smoke | |
| T-07 | Config endpoint | Smoke | |
| T-08 | Active tasks empty | Smoke | |
| T-09 | History empty | Smoke | |
| T-10 | Invalid report rejected | Smoke | |
| T-11 | Invalid kill switch rejected | Smoke | |
| T-12 | Invalid autonomy rejected | Smoke | |
| T-13 | Activate kill switch | Config | |
| T-14 | Config reflects kill | Config | |
| T-15 | Report blocked when killed | Config | |
| T-16 | Deactivate kill switch | Config | |
| T-17 | Change autonomy level | Config | |
| T-18 | All-healthy report | Integration | |
| T-19 | Down service → VTID + diagnosis | Integration | |
| T-20 | Dedup blocks second report | Integration | |
| T-21 | VTID in active tasks | Integration | |
| T-22 | OASIS events emitted | Integration | |
| T-23 | Full pipeline (diagnosis+spec+inject) | Pipeline | |
| T-24 | Spec generated event | Pipeline | |
| T-25 | Task visible in VTID API | Pipeline | |
| T-26 | History entry created | Pipeline | |
| T-27 | Verification (escalate expected) | Verification | |
| T-28 | Snapshots stored | Verification | |
| T-29 | Manual rollback | Verification | |
| T-30 | Dashboard renders | UI | |
| T-31 | Kill switch via UI | UI | |
