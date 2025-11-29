# VTID-0520: CI/CD Health Indicator in Command Hub

**VTID:** VTID-0520
**Status:** Implemented - Pending Deployment
**Layer:** DEV
**Module:** CICD / Frontend
**Scope:** Command Hub UI header toolbar enhancement
**Environment:** Vitana Dev Sandbox
**Created:** 2025-11-29
**Parent VTIDs:** VTID-0516 (Safe-Merge Layer), VTID-0518, VTID-0519

---

## 1. Objective

Display **real-time CI/CD health** in the Command Hub UI header toolbar, completing the "visibility + control" loop for deployments.

---

## 2. Data Source

**Endpoint:** `GET /api/v1/cicd/health`

**Expected Response:**
```json
{
  "ok": true,
  "status": "ok",
  "capabilities": {
    "create_pr": true,
    "safe_merge": true,
    "deploy_service": true
  }
}
```

---

## 3. Implementation Summary

### Files Modified

| File | Changes |
|------|---------|
| `services/gateway/src/frontend/command-hub/app.js` | Added CI/CD health state, polling logic, UI rendering |
| `services/gateway/src/frontend/command-hub/styles.css` | Added heartbeat icon styles, tooltip styles, animations |

### State Variables Added

```javascript
// CI/CD Health (VTID-0520)
cicdHealth: null,
cicdHealthLoading: false,
cicdHealthError: null,
cicdHealthTooltipOpen: false
```

### Polling Logic

- Polls `/api/v1/cicd/health` every **10 seconds**
- Starts automatically on app load via `startCicdHealthPolling()`
- Can be stopped via `stopCicdHealthPolling()`

### UI Element

Located in header toolbar right section (before LIVE pill):

| State | Visual |
|-------|--------|
| `ok=true` | Green heartbeat icon with pulse animation |
| `ok=false` | Red heartbeat icon with fast pulse animation |
| Loading | Gray pulsing icon |
| Error | Red heartbeat icon |

### Tooltip Features

- Click heartbeat icon to open tooltip
- Shows status text (Healthy/Issues)
- Shows capabilities with Yes/No indicators
- Shows last updated timestamp
- Click outside to close

---

## 4. CSP Compliance

All implementation follows CSP requirements:

- No inline scripts
- No inline styles
- All styles in external CSS file
- All JavaScript in external JS file
- Unicode characters for icons (CSP compliant)

---

## 5. Deployment Flow (Per VTID-0519)

### Step 1: Create PR via Gateway

```http
POST https://gateway-q74ibpv6ia-uc.a.run.app/api/v1/github/create-pr
Content-Type: application/json

{
  "vtid": "VTID-0520",
  "base": "main",
  "head": "claude/unified-deployment-governance-011Jbc7EVWiWjDMRZ2AAouHZ",
  "title": "feat(command-hub): add CI/CD health indicator in header toolbar (VTID-0520)",
  "body": "## Summary\n- Add CI/CD health indicator in Command Hub header toolbar\n- Polls /api/v1/cicd/health every 10 seconds\n- Green heartbeat when ok=true, red when ok=false\n- CSP compliant\n\n## VTID: VTID-0520"
}
```

### Step 2: Safe Merge via Gateway

```http
POST https://gateway-q74ibpv6ia-uc.a.run.app/api/v1/github/safe-merge
Content-Type: application/json

{
  "vtid": "VTID-0520",
  "repo": "exafyltd/vitana-platform",
  "pr_number": <PR_NUMBER>,
  "require_checks": true
}
```

### Step 3: Deploy Gateway Service

```http
POST https://gateway-q74ibpv6ia-uc.a.run.app/api/v1/deploy/service
Content-Type: application/json

{
  "vtid": "VTID-0520",
  "service": "gateway",
  "environment": "dev"
}
```

### Step 4: Verify

**CI/CD Health Check:**
```http
GET https://gateway-q74ibpv6ia-uc.a.run.app/api/v1/cicd/health
```

**UI Verification:**
1. Navigate to `https://gateway-q74ibpv6ia-uc.a.run.app/command-hub/`
2. Verify heartbeat icon appears in header within 5 seconds
3. Verify green color when CICD healthy
4. Click heartbeat to verify tooltip shows status + capabilities
5. Open DevTools Console, verify no CSP violations

---

## 6. Success Criteria

| Criterion | Status |
|-----------|--------|
| Command Hub header shows CI/CD health within 5 seconds of load | Implemented |
| CI/CD state updates dynamically (10s polling) | Implemented |
| No CSP violations | Implemented |
| API failures correctly show degraded state (red) | Implemented |
| Change deployed through Gateway per 0518/0519 rules | Pending |

---

## 7. Branch & Commit

- **Branch:** `claude/unified-deployment-governance-011Jbc7EVWiWjDMRZ2AAouHZ`
- **Commit:** `feat(command-hub): add CI/CD health indicator in header toolbar (VTID-0520)`
- **SHA:** `080d868` (pushed to origin)

---

## 8. Related VTIDs

| VTID | Description | Status |
|------|-------------|--------|
| VTID-0516 | Autonomous Safe-Merge Layer | Implemented |
| VTID-0518 | Standard Backend Deployment Pattern (DEV) | Canonical |
| VTID-0519 | Standard Frontend Deployment Pattern (DEV) | Canonical |
| VTID-0520 | CI/CD Health Indicator in Command Hub | **This VTID** |
| VTID-0521 | Auto VTID Ledger Writer | Next |

---

## 9. Visual Reference

### Healthy State
```
+--------------------------------------------------+
| [Heartbeat] [Autopilot] [Operator] [Clock]  [Publish]  [♥] [LIVE] |
|                                              ^                     |
|                                              Green pulsing heart   |
+--------------------------------------------------+
```

### Error State
```
+--------------------------------------------------+
| [Heartbeat] [Autopilot] [Operator] [Clock]  [Publish]  [♥] [LIVE] |
|                                              ^                     |
|                                              Red pulsing heart     |
+--------------------------------------------------+
```

### Tooltip (on click)
```
+------------------------+
| ♥ CI/CD Healthy        |
|------------------------|
| Status: ok             |
|                        |
| CAPABILITIES           |
| Create Pr: Yes         |
| Safe Merge: Yes        |
| Deploy Service: Yes    |
|------------------------|
| Updated: 10:45:23 AM   |
+------------------------+
```

---

**Maintained by:** Claude Agent
**Last updated:** 2025-11-29
**Next:** VTID-0521 (Auto VTID Ledger Writer)
