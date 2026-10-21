# VTID-0519: Standard Frontend Deployment Pattern (DEV)

**VTID:** VTID-0519
**Status:** Canonical / Locked
**Layer:** DEV
**Scope:** All frontend changes in exafyltd/vitana-platform that require PR, merge, and deploy to DEV
**Environment:** Vitana Dev Sandbox
**Created:** 2025-11-29
**Parent VTID:** VTID-0518 (Standard Backend Deployment Pattern)

---

## 1. Canonical Repos, Services, URLs

### Monorepo
- **Repository:** `exafyltd/vitana-platform` (single source of truth for frontend + backend + gateway + OASIS)

### Gateway (Dev, Canonical)
- **GATEWAY_URL:** `https://gateway-q74ibpv6ia-uc.a.run.app`

### Frontend Source Location
- **Canonical Path:** `services/gateway/src/frontend/command-hub/`
- **Build Output:** `services/gateway/dist/frontend/command-hub/`
- **Governance:** GOV-FRONTEND-CANONICAL-SOURCE-0001

### Frontend Files
| File | Purpose |
|------|---------|
| `index.html` | Main HTML entry point |
| `styles.css` | CSS styles (must be external, no inline) |
| `app.js` | Main JavaScript application (must be external, no inline) |
| `navigation-config.js` | Navigation configuration |

### Rule
Any other frontend path, alternate command-hub directory, or sibling UI folder is **invalid** and must be treated as a violation.

---

## 2. CI/CD Control Plane Endpoints (Gateway)

All frontend deployment flows in DEV must use these endpoints:

| Operation | Method | Endpoint |
|-----------|--------|----------|
| Create PR | POST | `{GATEWAY_URL}/api/v1/github/create-pr` |
| Safe Merge | POST | `{GATEWAY_URL}/api/v1/github/safe-merge` |
| Deploy Service | POST | `{GATEWAY_URL}/api/v1/deploy/service` |
| CI/CD Health | GET | `{GATEWAY_URL}/api/v1/cicd/health` |

### Rule
No direct `gcloud`, no `deploy.sh`, no GitHub UI clicks as primary path. Those are fallbacks only if Gateway CI/CD is broken and explicitly authorized by CEO/CTO.

---

## 3. Standard Flow (DEV Frontend Change)

For any frontend change (Command Hub UI):

### Step 1: Code & Branch

Implement changes in `exafyltd/vitana-platform` on a feature branch:
```
claude/feature-<shortname>-<nanoid>
```

All frontend changes must be in:
```
services/gateway/src/frontend/command-hub/
```

Include:
- UI component changes
- Style updates (external CSS only)
- JavaScript logic (external JS only)
- Navigation configuration updates

### Step 2: Create PR via Gateway

**Request:**
```http
POST https://gateway-q74ibpv6ia-uc.a.run.app/api/v1/github/create-pr
Content-Type: application/json

{
  "vtid": "AUTO",
  "base": "main",
  "head": "<feature-branch-name>",
  "title": "<PR title>",
  "body": "<Clear description of the UI change, including affected components and scope>"
}
```

**Expected Response:**
```json
{
  "ok": true,
  "pr_number": <NUMBER>,
  "pr_url": "https://github.com/exafyltd/vitana-platform/pull/<NUMBER>"
}
```

### Step 3: Safe Merge via Gateway (after CI passes)

**Request:**
```http
POST https://gateway-q74ibpv6ia-uc.a.run.app/api/v1/github/safe-merge
Content-Type: application/json

{
  "vtid": "AUTO",
  "repo": "exafyltd/vitana-platform",
  "pr_number": <PR_NUMBER_FROM_STEP_2>,
  "require_checks": true
}
```

**Behavior - Must block if:**
- PR doesn't exist / not open
- CI checks failed or pending
- Governance rules flag sensitive files / violations

### Step 4: Deploy Gateway Service via Gateway

**Request (Frontend change requires Gateway deployment):**
```http
POST https://gateway-q74ibpv6ia-uc.a.run.app/api/v1/deploy/service
Content-Type: application/json

{
  "vtid": "AUTO",
  "service": "gateway",
  "environment": "dev"
}
```

**Expected Response:**
```json
{
  "ok": true,
  "service": "gateway",
  "environment": "dev",
  "status": "queued",
  "workflow_run_url": "https://github.com/exafyltd/vitana-platform/actions/runs/..."
}
```

**Note:** Frontend changes are deployed via the Gateway service since the Command Hub UI is served by Gateway.

### Step 5: Verify

**CI/CD Layer Health:**
```http
GET https://gateway-q74ibpv6ia-uc.a.run.app/api/v1/cicd/health
```

**Expected Response:**
```json
{
  "ok": true,
  "status": "ok",
  "capabilities": {
    "github_integration": true,
    "oasis_events": true,
    "create_pr": true,
    "safe_merge": true,
    "deploy_service": true
  }
}
```

**UI Verification:**
```http
GET https://gateway-q74ibpv6ia-uc.a.run.app/command-hub/
```

Expected:
- HTTP 200
- HTML page loads correctly
- No CSP (Content Security Policy) errors in browser console
- Header renders correctly
- Sidebar navigation functional
- Route navigation works

**CSP Compliance Check:**
- Open browser Developer Tools (F12)
- Check Console tab for CSP violations
- Verify no inline scripts or styles are blocked
- All external resources load correctly

---

## 4. Forbidden Behaviors (Hard Rules)

Agents must **NOT**:

1. Use `gcloud run deploy`, `deploy.sh`, or Docker CLI as the primary deployment path in DEV

2. Introduce inline scripts or styles:
   - No `<script>...</script>` with inline code
   - No `<style>...</style>` with inline CSS
   - No `style="..."` inline attributes (minimal exceptions for dynamic values only)
   - No `onclick`, `onload`, or other inline event handlers

3. Ask the human to:
   - "Trigger deployment manually" in GitHub UI
   - "Click a workflow"
   - "Run deploy.sh in Cloud Shell" as the standard flow

4. Introduce or suggest:
   - Any gateway URL other than `https://gateway-q74ibpv6ia-uc.a.run.app`
   - Any frontend path other than `services/gateway/src/frontend/command-hub/`
   - Shadow directories or alternate command-hub locations

5. Create new deployment scripts for frontend changes

### Exception Handling

If Gateway CI/CD is truly broken, agents must:
1. Report failure via OASIS event + explanation
2. Propose a temporary fallback only with explicit CEO/CTO approval

---

## 5. CSP Compliance Requirements

All frontend code must comply with Content Security Policy:

### Allowed
- External CSS files: `<link rel="stylesheet" href="/command-hub/styles.css" />`
- External JS files: `<script src="/command-hub/app.js"></script>`
- Dynamic class manipulation via JavaScript
- CSS custom properties (variables)

### Forbidden
- Inline `<script>` tags with code
- Inline `<style>` tags
- `javascript:` URLs
- `eval()` or `new Function()` for dynamic code
- Inline event handlers (`onclick`, `onload`, etc.)

### Verification
After deployment, always verify no CSP errors appear in browser console:
1. Open Command Hub in browser
2. Open Developer Tools (F12)
3. Navigate to Console tab
4. Filter for "CSP" or "Content Security Policy"
5. Confirm zero violations

---

## 6. Agent Behavior Requirements

Any autonomous agent (Claude, Gemini, etc.) working on frontend tasks in DEV must:

### 6.1 Assume CI/CD Layer is Live
Assume the VTID-0516 CI/CD layer is live and authoritative.

### 6.2 Use Standard Pattern
Use the standard pattern documented here for every frontend change:
```
Code -> Commit -> Push -> Create-PR -> Safe-Merge -> Deploy Gateway -> Verify UI + CSP
```

### 6.3 Sandbox Network Restrictions
When sandbox cannot reach Gateway:
- Still produce the correct HTTP calls, JSON payloads, and expected outcomes
- Never claim "endpoint doesn't exist" or "CI/CD not deployed" based solely on sandbox 403/timeout

### 6.4 VTID Tracking
Log and reference VTID in:
- PR body
- Gateway CI/CD calls
- OASIS events

### 6.5 CSP Awareness
Always check for CSP compliance before committing frontend changes:
- No inline scripts
- No inline styles
- All resources loaded externally

---

## 7. Implementation Reference

### Frontend Source Files
- **Directory:** `services/gateway/src/frontend/command-hub/`
- **Governance:** GOV-FRONTEND-CANONICAL-SOURCE-0001

### Gateway Static Serving
- **File:** `services/gateway/src/server.ts`
- **Mount:** Express static middleware serves `/command-hub/` route

### Gateway CI/CD Routes
- **File:** `services/gateway/src/routes/cicd.ts`
- **VTID:** VTID-0516

### Types & Schemas
- **File:** `services/gateway/src/types/cicd.ts`
- **Schemas:** `CreatePrRequestSchema`, `SafeMergeRequestSchema`, `DeployServiceRequestSchema`

### GitHub Actions Workflows
- **EXEC-DEPLOY:** `.github/workflows/EXEC-DEPLOY.yml`
- **Gateway CI:** `.github/workflows/CICDL-GATEWAY-CI.yml`

### OASIS Event Tracking
- **File:** `services/gateway/src/services/oasis-event-service.ts`

---

## 8. Comparison: Backend vs Frontend Pattern

| Aspect | Backend (VTID-0518) | Frontend (VTID-0519) |
|--------|---------------------|----------------------|
| Code Location | Various service directories | `services/gateway/src/frontend/command-hub/` |
| Deploy Service | `oasis-operator`, `oasis-projector`, `gateway` | `gateway` (always) |
| Verification | API endpoint health check | UI loads + CSP compliance |
| Additional Rules | N/A | No inline scripts/styles |
| Governance | Standard PR/merge flow | GOV-FRONTEND-CANONICAL-SOURCE-0001 |

---

## 9. Related VTIDs

| VTID | Description | Status |
|------|-------------|--------|
| VTID-0516 | Autonomous Safe-Merge Layer | Implemented |
| VTID-0518 | Standard Backend Deployment Pattern (DEV) | Canonical |
| DEV-CICDL-0034 | Self-Contained CI Pipeline | Implemented |
| DEV-CICDL-0035 | Restore Full CI Coverage | Pending |

---

**Maintained by:** Vitana Platform Team
**Last updated:** 2025-11-29
**Related:** [VTID System](../VTID_SYSTEM.md), [Backend Pattern](./VTID-0518-BACKEND-DEPLOYMENT-PATTERN-DEV.md)
