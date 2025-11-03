---
doc_id: DOC-30-0300
title: "Vitana DevOps, OASIS & Autonomous Infrastructure Strategy"
version: 0.1.0
status: canonical
template: concept
owner: "CTO"
tags: [devops, oasis, infrastructure, vtid, autopilot, agents]
related_vtids: []
related_docs: [DOC-00-0001, DOC-00-0003, DOC-95-9500]
created_at: "2025-11-03"
updated_at: "2025-11-03"
---

# Vitana DevOps, OASIS & Autonomous Infrastructure Strategy

## Executive Summary

This document defines the **infrastructure and operational architecture** that powers the Vitana ecosystem (Maxina, AlKalma, Earthlings). Unlike DOC-00-0001 (which describes what Vitana is for members), this document explains **how Vitana operates internally** from a technical and DevOps perspective.

**Core Components:**
- **OASIS** (Operational Audit & State Integration System) – Single source of truth for all events and state
- **VTID** (Vitana Task Identifier) – Work tracking system for infrastructure and product development
- **Autonomous Agents** – AI-powered services that execute approved tasks (deployments, PR merges, monitoring)
- **Gateway** – Central API routing and authentication layer
- **CI/CD Pipelines** – Automated testing, building, and deployment workflows

**Key Principle:** Infrastructure autonomy within bounded safety limits—agents can execute routine tasks but escalate when uncertain or outside defined boundaries.

---

## 1. Purpose & Scope

### What This Document Covers

- **OASIS architecture:** Event ledger, state tracking, audit trails
- **VTID system:** How work items are tracked across infrastructure and product development
- **Autonomous agent framework:** GitHub Agent, Deployment Agent, Monitoring Agent capabilities and boundaries
- **CI/CD patterns:** Automated testing, deployment, rollback procedures
- **DevOps principles:** Uptime targets, incident response, escalation protocols

### What This Document Does NOT Cover

- **Member-facing product features** → See DOC-00-0001 (Vitana Vision)
- **Autopilot modes** → See DOC-95-9500 (Autopilot Modes Overview)
- **Detailed API specifications** → See DOC-30-03XX series (future docs)
- **Tenant-specific architecture** → See DOC-20-02XX series (Maxina, AlKalma, Earthlings)

### Audience

- **CTO, VP Engineering, Infrastructure Team**
- **DevOps engineers and SREs**
- **Autonomous agents (Claude, future AI systems)**
- **External auditors (security, compliance)**

---

## 2. OASIS: Single Source of Truth

### What OASIS Is

**OASIS** (Operational Audit & State Integration System) is the central event ledger and state tracker for all Vitana infrastructure operations. Every significant action—deployments, PR merges, service health checks, VTID state changes—is logged as an event in OASIS.

**Key Properties:**
- **Immutable event log:** Events are append-only, never deleted or modified
- **Queryable:** SQL-based queries for auditing, debugging, and analytics
- **Cross-service:** All services (Gateway, Agents, Tenants) emit events to OASIS
- **Real-time:** Events are indexed within seconds for near-real-time visibility

### Database Schema

**Primary Tables:**

1. **events** – All system events
```sql
   CREATE TABLE events (
     id UUID PRIMARY KEY,
     event_type TEXT NOT NULL,
     source_service TEXT NOT NULL,
     vtid TEXT,
     actor TEXT NOT NULL,
     metadata JSONB NOT NULL,
     timestamp TIMESTAMP NOT NULL,
     environment TEXT NOT NULL
   );
```

2. **vtid_tracking** – VTID lifecycle states
```sql
   CREATE TABLE vtid_tracking (
     id UUID PRIMARY KEY,
     vtid TEXT UNIQUE NOT NULL,
     domain TEXT NOT NULL,
     category TEXT NOT NULL,
     number INTEGER NOT NULL,
     state TEXT NOT NULL,
     created_at TIMESTAMP NOT NULL,
     updated_at TIMESTAMP NOT NULL,
     assigned_to TEXT,
     metadata JSONB
   );
```

3. **deployments** – Deployment history
```sql
   CREATE TABLE deployments (
     id UUID PRIMARY KEY,
     service_name TEXT NOT NULL,
     version TEXT NOT NULL,
     environment TEXT NOT NULL,
     status TEXT NOT NULL,
     initiated_by TEXT NOT NULL,
     initiated_at TIMESTAMP NOT NULL,
     completed_at TIMESTAMP,
     rollback_of UUID REFERENCES deployments(id),
     metadata JSONB
   );
```

4. **service_health** – Real-time service health
```sql
   CREATE TABLE service_health (
     id UUID PRIMARY KEY,
     service_name TEXT NOT NULL,
     environment TEXT NOT NULL,
     status TEXT NOT NULL,
     last_check TIMESTAMP NOT NULL,
     response_time_ms INTEGER,
     metadata JSONB,
     UNIQUE (service_name, environment)
   );
```

### Event Types

**Infrastructure Events:**
- `ci.workflow_started` / `ci.workflow_completed`
- `cd.deployment_started` / `cd.deployment_completed`
- `cd.rollback_initiated` / `cd.rollback_completed`

**VTID Events:**
- `vtid.created` / `vtid.state_changed` / `vtid.closed`

**Service Events:**
- `service.started` / `service.stopped`
- `service.health_check` / `service.error`

**Agent Events:**
- `agent.task_started` / `agent.task_completed`
- `agent.escalation` / `agent.recovery_attempted`

**GitHub Events:**
- `github.pr_opened` / `github.pr_merged` / `github.pr_closed`
- `github.commit_pushed`

### OASIS API Endpoints
```
POST   /events                 → Emit new event
GET    /events                 → Query events (filterable by vtid, type, service, time range)
GET    /vtids/:vtid            → Get VTID details + event history
POST   /vtids                  → Create new VTID
PATCH  /vtids/:vtid            → Update VTID state
GET    /deployments            → List deployment history
GET    /health/services        → Current service health status
```

### Integration with DevOps Chat

All events in OASIS trigger notifications to the **DevOps Chat** channel (Slack, Discord, or Teams):

**Notification Priority:**
- **Critical** (immediate alert): Production outages, security issues, deployment failures
- **High** (within 5 min): PR merges, staging deployments, agent escalations
- **Medium** (batched every 15 min): VTID state changes, dev deployments
- **Low** (daily digest): Health checks, routine tasks

**Example Notification:**
```
🔔 OASIS Event
Type: cd.deployment_completed
Service: gateway
Environment: production
Status: success
VTID: OPS-INFRA-0142
Duration: 3m 42s
Actor: deployment-agent
Time: 2025-11-03 14:22 UTC
```

---

## 3. VTID System: Work Tracking

### What VTIDs Are

**VTID** (Vitana Task Identifier) is a unique identifier for every unit of infrastructure or product work. Unlike member-facing work (which is tracked in tenant apps), VTIDs track **internal development, operations, and infrastructure tasks**.

**Format:** `{DOMAIN}-{CATEGORY}-{NUMBER}`

### VTID Domains

- **DEV** – Development work (features, refactoring, tech debt)
- **OPS** – Operations work (deployments, infrastructure, monitoring)
- **BUG** – Bug fixes
- **SEC** – Security issues
- **DOC** – Documentation

### VTID Categories

- **CICDL** – CI/CD pipelines, automation
- **API** – API development, endpoints
- **DB** – Database schema changes, migrations
- **INFRA** – Infrastructure, GCP resources, networking
- **AGENT** – Autonomous agent development
- **GATEWAY** – Gateway service development

**Examples:**
- `DEV-CICDL-0031` – Development work on CI/CD, task #31
- `OPS-INFRA-0142` – Operations infrastructure task #142
- `BUG-API-0099` – API bug fix #99

### VTID Lifecycle States

1. **created** – VTID registered, work not started
2. **in_progress** – Active development
3. **testing** – Validation phase
4. **review** – PR open, awaiting review
5. **merged** – PR merged to target branch
6. **deployed** – Changes live in environment
7. **verified** – Post-deployment validation complete
8. **closed** – Work complete, VTID archived

### VTID in GitHub Workflow

**Branch naming:**
```
feature/DEV-CICDL-0031-phase2a-validation
bugfix/BUG-API-0099-auth-token
ops/OPS-INFRA-0142-cloudrun-scaling
```

**PR titles:**
```
[DEV-CICDL-0031] Add Phase 2A validation workflow
[BUG-API-0099] Fix authentication token expiration
[OPS-INFRA-0142] Optimize Cloud Run auto-scaling
```

**Commit messages:**
```
feat(cicd): add validation workflow

- Add lint job
- Add unit test job
- Emit OASIS events

VTID: DEV-CICDL-0031
```

### Auto-Labeling

GitHub Actions automatically applies labels to PRs based on VTID:
- Domain label: `dev`, `ops`, `bug`, `sec`, `doc`
- Category label: `cicd`, `api`, `infra`, `gateway`, `agent`
- VTID label: `vtid:DEV-CICDL-0031`

---

## 4. Autonomous Agent Framework

### Philosophy: Bounded Autonomy

**Autonomous agents** (powered by Claude or similar AI systems) can execute approved tasks without human intervention, but only within defined safety boundaries. When uncertain or outside boundaries, agents **must escalate** to CTO, VP Engineering, or on-call engineer.

**Key Principle (from DOC-00-0003):**
> "AI agents execute routine tasks autonomously but escalate decisions requiring human judgment, creativity, or ethical considerations. Agents never pretend to be human and always identify themselves."

### Agent Types

#### 4.1 GitHub Agent

**Purpose:** Automate GitHub operations (PRs, merges, branch management)

**Autonomous Capabilities:**
- Create feature branches from `main` or `develop`
- Open pull requests with VTID in title
- Merge PRs after CI passes + approvals received
- Delete merged branches
- Apply labels automatically
- Post PR comments with status updates
- Close stale PRs (after 30 days of inactivity)

**Escalation Triggers:**
- CI checks fail repeatedly (>3 attempts)
- Merge conflicts that can't be auto-resolved
- PR requires manual security review
- Breaking changes detected in API schemas

**Configuration:**
```yaml
github_agent:
  auto_merge:
    enabled: true
    require_ci_pass: true
    require_approvals: 1
    delete_branch_after: true
  auto_label:
    enabled: true
  stale_pr_policy:
    days_until_stale: 30
    auto_close: false  # Always escalate before closing
```

#### 4.2 Deployment Agent

**Purpose:** Orchestrate Cloud Run deployments across environments

**Autonomous Capabilities:**
- Deploy to **dev** environment (on merge to `develop`)
- Deploy to **staging** environment (on merge to `main`)
- Run pre-deployment health checks
- Execute smoke tests post-deployment
- Monitor error rates for 15 minutes post-deployment
- Auto-rollback if error rate >5% for 5 consecutive minutes
- Update OASIS deployment records
- Notify DevOps chat

**Escalation Triggers:**
- Production deployments (always require manual approval)
- Rollback fails (manual intervention needed)
- Smoke tests fail in staging
- Database migrations detected (require manual review)
- GCP permission errors

**Deployment Flow:**
```
1. Receive deployment request (VTID, service, environment, version)
2. Check service health in target environment
3. Build Docker image (if not already built)
4. Push to GCP Container Registry
5. Deploy to Cloud Run
   - Dev: Rolling update (zero-downtime)
   - Staging: Blue-green deployment (gradual traffic shift)
   - Prod: Manual approval required (agent cannot deploy)
6. Run smoke tests
7. Monitor error rates (15 min window)
8. Update OASIS (success/failure)
9. Notify DevOps chat
10. If failure → initiate rollback (auto for dev/staging, escalate for prod)
```

**Configuration:**
```yaml
deployment_agent:
  auto_deploy:
    dev: true       # Auto-deploy on merge to develop
    staging: true   # Auto-deploy on merge to main
    prod: false     # Always require manual approval
  smoke_tests:
    enabled: true
    timeout: 60s
  monitoring:
    duration: 900s  # 15 minutes
    error_threshold: 5  # percent
  rollback:
    auto_rollback_on_failure: true
    max_retry_attempts: 2
```

#### 4.3 Monitoring Agent

**Purpose:** Continuous health monitoring and auto-recovery

**Autonomous Capabilities:**
- Execute health checks every 60 seconds (all services, all environments)
- Detect service degradation (response time >1s, error rate >1%)
- Attempt auto-recovery:
  - Restart service (Cloud Run revision rollback)
  - Scale up instances (+1 if at min capacity)
  - Check dependencies (database, external APIs)
- Update OASIS `service_health` table
- Alert DevOps chat on anomalies

**Escalation Triggers:**
- Service down >5 minutes despite recovery attempts
- Database connection failures
- GCP API errors (quota, permissions)
- Production outage (always escalate + page on-call)

**Auto-Recovery Decision Tree:**
```
Issue: Service not responding
Actions:
  1. Check last deployment (if <10 min ago, may be rolling update → wait)
  2. Attempt service restart (rollback to previous Cloud Run revision)
  3. Scale up instances (+1)
  4. Check database connectivity
  5. If still failing after 3 attempts → ESCALATE

Issue: High error rate (>5%)
Actions:
  1. Check recent deployments (if new deployment in last 30 min → consider rollback)
  2. Query OASIS for similar incidents
  3. If error pattern matches known issue → apply fix
  4. If unknown pattern → ESCALATE

Issue: High latency (p95 >1s)
Actions:
  1. Check instance count (if at max → ESCALATE for capacity increase)
  2. Scale up instances
  3. Check database slow queries
  4. If persistent → ESCALATE
```

**Configuration:**
```yaml
monitoring_agent:
  health_check:
    interval: 60s
    timeout: 5s
    failure_threshold: 3
  auto_recovery:
    enabled: true
    max_attempts: 3
  alerting:
    dev: devops-chat
    staging: devops-chat + email
    prod: devops-chat + email + pagerduty
```

---

## 5. CI/CD Pipeline Architecture

### Pipeline Stages

**Stage 1: Validation** (on PR open/update)
```yaml
jobs:
  lint:
    - Run ESLint + Prettier
    - Emit: ci.lint_completed
  type-check:
    - Run TypeScript compiler
    - Emit: ci.typecheck_completed
  unit-tests:
    - Run Jest unit tests
    - Require: >80% coverage
    - Emit: ci.unit_tests_completed
  integration-tests:
    - Spin up test database
    - Run integration tests
    - Emit: ci.integration_tests_completed
  security-scan:
    - Run Trivy for vulnerabilities
    - Fail if: Critical or High vulnerabilities found
    - Emit: ci.security_scan_completed
```

**Stage 2: Build** (on merge to `develop` or `main`)
```yaml
jobs:
  build-image:
    - Build Docker image
    - Tag: gcr.io/PROJECT/SERVICE:COMMIT_SHA
    - Tag: gcr.io/PROJECT/SERVICE:latest
    - Push to GCP Container Registry
    - Emit: ci.build_completed
```

**Stage 3: Deploy** (automatic for dev/staging, manual for prod)
```yaml
jobs:
  deploy-dev:
    if: branch == 'develop'
    - Deploy to Cloud Run (dev environment)
    - Run smoke tests
    - Monitor error rates (5 min)
    - Emit: cd.deployment_completed
  
  deploy-staging:
    if: branch == 'main'
    - Deploy to Cloud Run (staging environment)
    - Run smoke tests
    - Monitor error rates (15 min)
    - Emit: cd.deployment_completed
  
  deploy-prod:
    if: manual trigger + approval
    - Wait for manual approval (CTO or VP Engineering)
    - Deploy to Cloud Run (production environment)
    - Blue-green traffic shift (10% → 50% → 100% over 30 min)
    - Monitor error rates (30 min)
    - Emit: cd.deployment_completed
```

**Stage 4: Monitor** (post-deployment)
```yaml
jobs:
  post-deploy-monitoring:
    - Query Cloud Logging for errors (15 min window)
    - Check p95/p99 latency
    - If error_rate >5%: Trigger rollback
    - If latency >1s: Alert DevOps team
    - Emit: cd.monitoring_completed
```

### Branch Protection Rules

**`main` branch:**
- Require PR before merge
- Require 1 approval
- Require status checks: `lint`, `type-check`, `unit-tests`, `integration-tests`, `security-scan`
- Require linear history
- Automatically delete merged branches

**`develop` branch:**
- Require PR before merge
- Require status checks: `lint`, `type-check`, `unit-tests`
- Approvals optional (for speed)

### Rollback Procedure

**Automatic Rollback (dev/staging):**
```
1. Detect failure (error rate >5% for 5 min, or smoke tests fail)
2. Identify last known good revision (query OASIS deployments table)
3. Execute Cloud Run traffic shift to previous revision (100% traffic)
4. Verify service recovery (health check + error rate check)
5. Emit OASIS event: cd.rollback_completed
6. Notify DevOps chat
7. Create incident report (VTID auto-created: BUG-INFRA-XXXX)
```

**Manual Rollback (production):**
```
1. On-call engineer triggers rollback via GitHub Actions workflow_dispatch
2. Select target revision (from dropdown of last 5 revisions)
3. Confirm rollback (requires reason in text field)
4. Execute traffic shift (immediate 100% to selected revision)
5. Monitor for 30 minutes
6. Emit OASIS event: cd.rollback_completed
7. Post-mortem required within 24 hours
```

---

## 6. Infrastructure Components

### 6.1 Gateway Service

**Purpose:** Central API entry point for all Vitana services

**Responsibilities:**
- Request routing to backend services (OASIS, Maxina, AlKalma, Earthlings)
- Authentication & authorization (JWT validation)
- Rate limiting (per-user, per-IP)
- Request/response logging
- OpenAPI specification hosting
- CORS handling

**Technology:**
- Framework: Express.js
- Language: TypeScript
- Deployment: Cloud Run (GCP)
- Port: 8080

**Scaling:**
- Dev: Min 0, Max 2
- Staging: Min 1, Max 5
- Prod: Min 2, Max 10

### 6.2 OASIS Service

**Purpose:** Event ledger and state tracker (described in Section 2)

**Technology:**
- Database: PostgreSQL (Supabase)
- ORM: Prisma
- API Framework: Express.js
- Deployment: Cloud Run (GCP)

**Scaling:**
- Dev: Min 0, Max 2
- Staging: Min 1, Max 3
- Prod: Min 1, Max 5

### 6.3 Agent Services

**Deployment:**
- GitHub Agent: Cloud Run (min 0, max 2)
- Deployment Agent: Cloud Run (min 1, max 2) – always ready
- Monitoring Agent: Cloud Run (min 1, max 1) – singleton

**Triggers:**
- GitHub Agent: Webhook from GitHub Actions
- Deployment Agent: GitHub Actions + OASIS API calls
- Monitoring Agent: Cron (every 60 seconds)

### 6.4 Notification Service

**Purpose:** Dispatch notifications to DevOps chat

**Responsibilities:**
- Listen for OASIS events (via webhook)
- Format messages per channel (Slack, Discord, Teams)
- Batch non-critical events (every 15 min)
- Immediate dispatch for critical events

---

## 7. Security & Compliance

### Authentication & Authorization

**Service-to-Service:**
- GCP Service Accounts with scoped IAM roles
- JWT tokens for API calls (short-lived, 1-hour expiry)
- Secrets stored in GCP Secret Manager (rotated quarterly)

**External APIs:**
- GitHub: Personal Access Token (PAT) with repo scope
- Supabase: Service role key (never exposed to clients)

### Network Security

**Cloud Run Services:**
- Internal-only by default (except Gateway)
- Gateway: Public, but behind Cloud Armor (DDoS protection)
- Supabase: IP whitelist (Cloud Run NAT IPs only)

### Audit Trails

**OASIS events provide complete audit trail:**
- Who: `actor` field (human username or `deployment-agent`)
- What: `event_type` + `metadata`
- When: `timestamp` (UTC)
- Where: `environment` + `source_service`

**Retention:**
- Dev events: 30 days
- Staging events: 90 days
- Production events: 7 years (compliance requirement)

### Incident Response

**Severity Levels:**
- **P0 (Critical):** Production down, data breach, security incident
  - Response time: 15 minutes
  - Escalation: Page on-call + notify CTO
- **P1 (High):** Staging down, deployment failures, performance degradation
  - Response time: 1 hour
  - Escalation: DevOps chat + email
- **P2 (Medium):** Non-critical bugs, minor outages in dev
  - Response time: 4 hours
  - Escalation: DevOps chat only
- **P3 (Low):** Nice-to-have fixes, documentation updates
  - Response time: 1 week
  - Escalation: None (VTID created, added to backlog)

---

## 8. Operational Metrics & SLOs

### Service Level Objectives (SLOs)

**Uptime:**
- Production: 99.9% (43 minutes downtime/month allowed)
- Staging: 99% (7 hours downtime/month allowed)
- Dev: Best effort (no SLO)

**Latency:**
- p50: <200ms
- p95: <500ms
- p99: <1000ms

**Error Rate:**
- Production: <0.1%
- Staging: <1%

### Key Metrics (Tracked in OASIS)

**Deployment Frequency:**
- Target: 10+ deployments/day (dev), 5+ deployments/week (staging), 2+ deployments/week (prod)

**Change Failure Rate:**
- Target: <5% (deployments requiring rollback)

**Mean Time to Recovery (MTTR):**
- Target: <15 minutes (automatic rollback in dev/staging)

**Mean Time Between Failures (MTBF):**
- Target: >7 days (no P0 incidents for a week)

### Monitoring Dashboards

**Real-Time Dashboard (Grafana):**
- Service health (all environments)
- Error rates (last 1 hour, 24 hours, 7 days)
- Latency (p50, p95, p99)
- Deployment timeline

**OASIS Analytics Dashboard:**
- VTID completion rate (% closed within 7 days)
- Agent escalation rate (% of tasks requiring human intervention)
- CI/CD pipeline duration (median, p95)

---

## 9. Agent Escalation Protocols

### When Agents Must Escalate

**GitHub Agent:**
- Merge conflicts requiring manual resolution
- CI failures after 3 retry attempts
- Security vulnerabilities detected (Critical or High severity)
- Breaking API changes in PR

**Deployment Agent:**
- Production deployment requests (always manual approval)
- Rollback failures
- Database migrations detected
- GCP quota exceeded or permission errors

**Monitoring Agent:**
- Service down >5 minutes (despite recovery attempts)
- Production outage (any duration)
- Database connection failures
- Unknown error patterns

### Escalation Channels

**DevOps Chat:**
- All escalations posted here immediately
- Format: `🚨 AGENT ESCALATION | {service} | {reason} | {vtid}`

**Email:**
- CTO, VP Engineering, on-call engineer
- Only for P0 (critical) incidents

**PagerDuty:**
- Production outages only
- Automatically pages on-call engineer

**OASIS Event:**
- `agent.escalation` event emitted with full context
- Queryable for post-incident analysis

---

## 10. Future Enhancements

**Q2 2026:**
- Multi-region deployment (US West, US East, EU)
- Advanced observability (OpenTelemetry, distributed tracing)
- Chaos engineering (automated fault injection testing)

**Q3 2026:**
- Agent self-learning (agents learn from past escalations, reduce future escalations)
- Predictive rollback (ML model predicts deployment failures before they happen)

**Q4 2026:**
- Multi-cloud (AWS + GCP for redundancy)
- Edge deployments (Cloudflare Workers for <50ms latency)

---

## Conclusion

Vitana's infrastructure is designed for **autonomous operation within safety boundaries**. Agents handle routine tasks (deployments, PR merges, health checks), freeing humans to focus on strategic work. OASIS provides complete visibility and auditability. VTIDs ensure every task is tracked from creation to closure.

**Core Principles:**
1. **Automate the routine, escalate the complex**
2. **Immutable audit trail (OASIS) for all actions**
3. **Bounded autonomy (agents operate within defined limits)**
4. **Default-safe behavior (when uncertain, escalate)**
5. **Transparency (all agent actions visible in DevOps chat + OASIS)**

---

**Owner:** CTO  
**Review Cadence:** Quarterly  
**Feedback:** DevOps chat or email cto@vitana.com
