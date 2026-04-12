# VTID-0518: Standard Backend Deployment Pattern (DEV)

**VTID:** VTID-0518
**Status:** Canonical / Locked
**Layer:** DEV
**Scope:** All backend changes in exafyltd/vitana-platform that require PR, merge, and deploy to DEV
**Environment:** Vitana Dev Sandbox
**Created:** 2025-11-28
**Parent VTID:** VTID-0516 (Autonomous Safe-Merge Layer)

---

## 1. Canonical Repos, Services, URLs

### Monorepo
- **Repository:** `exafyltd/vitana-platform` (single source of truth for backend + gateway + OASIS)

### Gateway (Dev, Canonical)
- **GATEWAY_URL:** `https://gateway-q74ibpv6ia-uc.a.run.app`

### OASIS-Related Runtime Service
- **Service:** `oasis-operator` for OASIS backend deployments

### Rule
Any other gateway URL or backend repo (vitana-backend, vitana-dev-gateway-*, etc.) is **invalid** and must be treated as a violation.

---

## 2. CI/CD Control Plane Endpoints (Gateway)

All backend deployment flows in DEV must use these endpoints:

| Operation | Method | Endpoint |
|-----------|--------|----------|
| Create PR | POST | `{GATEWAY_URL}/api/v1/github/create-pr` |
| Safe Merge | POST | `{GATEWAY_URL}/api/v1/github/safe-merge` |
| Deploy Service | POST | `{GATEWAY_URL}/api/v1/deploy/service` |
| CI/CD Health | GET | `{GATEWAY_URL}/api/v1/cicd/health` |

### Rule
No direct `gcloud`, no `deploy.sh`, no GitHub UI clicks as primary path. Those are fallbacks only if Gateway CI/CD is broken and explicitly authorized by CEO/CTO.

---

## 3. Standard Flow (DEV Backend Change)

For any backend change (example: OASIS tasks API):

### Step 1: Code & Branch

Implement changes in `exafyltd/vitana-platform` on a feature branch:
```
claude/fix-issue-<SESSION_ID>
```

Include:
- Code changes
- Migrations
- Tests
- Wiring to the correct service (e.g., OASIS Operator)

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
  "body": "<Clear description of the change, including endpoints, migrations, and scope>"
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

### Step 4: Deploy Target Service via Gateway

**Request (OASIS-related change):**
```http
POST https://gateway-q74ibpv6ia-uc.a.run.app/api/v1/deploy/service
Content-Type: application/json

{
  "vtid": "AUTO",
  "service": "oasis-operator",
  "environment": "dev"
}
```

**Expected Response:**
```json
{
  "ok": true,
  "service": "oasis-operator",
  "environment": "dev",
  "status": "queued",
  "workflow_run_url": "https://github.com/exafyltd/vitana-platform/actions/runs/..."
}
```

**Allowed Services:**
- `gateway`
- `oasis-operator`
- `oasis-projector`

The endpoint triggers GitHub Actions (EXEC-DEPLOY or equivalent). It does not need to wait for rollout synchronously; health is verified in the next step.

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

**Feature-level Endpoint Health (OASIS tasks example):**
```http
GET https://gateway-q74ibpv6ia-uc.a.run.app/api/v1/oasis/tasks?limit=50
```

Expected:
- HTTP 200
- JSON array of tasks (possibly `[]` initially)

Optional: Check OASIS events for deployment VTID for audit.

---

## 4. Forbidden Behaviors (Hard Rules)

Agents must **NOT**:

1. Use `gcloud run deploy`, `deploy.sh`, or Docker CLI as the primary deployment path in DEV

2. Ask the human to:
   - "Trigger deployment manually" in GitHub UI
   - "Click a workflow"
   - "Run deploy.sh in Cloud Shell" as the standard flow

3. Introduce or suggest:
   - Any gateway URL other than `https://gateway-q74ibpv6ia-uc.a.run.app`
   - Any backend repo other than `exafyltd/vitana-platform` for OASIS/gateway work

### Exception Handling

If Gateway CI/CD is truly broken, agents must:
1. Report failure via OASIS event + explanation
2. Propose a temporary fallback only with explicit CEO/CTO approval

---

## 5. Agent Behavior Requirements

Any autonomous agent (Claude, Gemini, etc.) working on backend tasks in DEV must:

### 5.1 Assume CI/CD Layer is Live
Assume the VTID-0516 CI/CD layer is live and authoritative.

### 5.2 Use Standard Pattern
Use the standard pattern documented here for every backend change:
```
Code -> Commit -> Push -> Create-PR -> Safe-Merge -> Deploy -> Verify
```

### 5.3 Sandbox Network Restrictions
When sandbox cannot reach Gateway:
- Still produce the correct HTTP calls, JSON payloads, and expected outcomes
- Never claim "endpoint doesn't exist" or "CI/CD not deployed" based solely on sandbox 403/timeout

### 5.4 VTID Tracking
Log and reference VTID in:
- PR body
- Gateway CI/CD calls
- OASIS events

---

## 6. Implementation Reference

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

## 7. Related VTIDs

| VTID | Description | Status |
|------|-------------|--------|
| VTID-0516 | Autonomous Safe-Merge Layer | Implemented |
| DEV-CICDL-0034 | Self-Contained CI Pipeline | Implemented |
| DEV-CICDL-0035 | Restore Full CI Coverage | Pending |

---

**Maintained by:** Vitana Platform Team
**Last updated:** 2025-11-28
**Related:** [VTID System](../VTID_SYSTEM.md), [CI/CD Implementation](../DEV-CICDL-0034-IMPLEMENTATION.md)
