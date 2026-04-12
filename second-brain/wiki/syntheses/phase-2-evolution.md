# Phase 2 Evolution: From Live Events to Runtime Fabric

> Cross-cutting synthesis of Phase 2 -> 2B -> 2C: how Vitana's infrastructure matured from basic event ingestion to a fully governed, observable, VTID-aware runtime fabric.

## The Arc

Phase 2 represents the most significant infrastructure maturation in Vitana's engineering history. Across three sub-phases executed in late October 2025, the platform evolved from having no operational observability to a state where every service, deployment, CI run, and agent interaction is tracked, governed, and visible in real-time.

| Phase | VTID | Name | Core Achievement |
|-------|------|------|-----------------|
| 2A | DEV-CICDL-0031 | Live Events | GitHub/GCP events flow into OASIS and stream to Live Console via SSE |
| 2B | DEV-CICDL-0031 | Naming Governance | CI-enforced naming conventions, OpenAPI specs, PR templates |
| 2C | DEV-CICDL-0033 | Runtime Fabric | Agent manifests, deploy telemetry, Cloud Run labels, repo scaffolding |

## Phase 2A: The Observation Layer

**Problem:** Vitana had no way to observe what was happening across its infrastructure in real-time. GitHub Actions ran silently. Deploys happened without records. Agent services had no heartbeat.

**Solution:** Build a live event pipeline.

**Key decisions:**
1. **OASIS as the universal event bus.** Rather than building separate monitoring for each system, all events (GitHub webhooks, deploy events, agent heartbeats) flow into OASIS's `oasis_events` table and are streamed via SSE.
2. **HMAC-verified GitHub webhooks.** Webhook endpoint at `/webhooks/github` verifies signatures and extracts VTIDs from PR titles, branch names, and commit messages using a cascading extraction strategy.
3. **Agent heartbeat utility.** A reusable `packages/agent-heartbeat.ts` module that any agent service can import, providing 60-second coalesced heartbeats with VTID tracking.

**What was built:** 5 new files, 2 modified files. The event flow: GitHub Action -> webhook -> HMAC verify -> VTID extract -> oasis_events -> SSE -> Live Console.

**What was deferred:** Database migration application, webhook configuration, and gateway deployment were left as manual steps for the CEO.

## Phase 2B: The Governance Layer

**Problem:** No enforced standards. Workflow files mixed naming conventions. No VTID tracking on deployments. No API documentation. Manual verification only.

**Solution:** Establish and enforce naming conventions through CI automation.

**Key decisions:**
1. **CI as the enforcement mechanism.** Rather than relying on documentation or code review, Phase 2B made naming conventions machine-enforceable. The `PHASE-2B-NAMING-ENFORCEMENT.yml` workflow blocks non-compliant PRs.
2. **VTID labels on Cloud Run services.** The `ensure-vtid.sh` guard script validates VTID format and generates `--labels` flags for `gcloud run deploy`. This creates a direct link between running services and the VTID that authorized them.
3. **OpenAPI as the API contract.** Two OpenAPI 3.0.3 specs (gateway-v1.yml, oasis-v1.yml) document all endpoints, providing machine-readable API contracts that can be validated by Spectral in CI.
4. **Local-first verification.** The `verify-phase2b-compliance.sh` script lets developers check compliance before pushing, reducing CI feedback loop time.

**What was built:** 8 files total. Established 7 naming conventions covering workflows, code files, VTID constants, event types, event status, event titles, and Cloud Run labels.

**Impact:** 100% consistency (enforced by CI), 6 automated compliance dimensions, 10+ documented API endpoints.

## Phase 2C: The Runtime Fabric

**Problem:** Even with events and naming governance, the infrastructure was not self-describing. Agent services had no manifests. Deployments did not emit telemetry. Cloud Run services lacked VTID labels. No canonical repository structure was documented.

**Solution:** Make every piece of infrastructure VTID-aware and self-describing.

**Key decisions:**
1. **Agent manifests as the identity layer.** Every agent service now has a `manifest.json` with standardized fields: name, layer, module, provider policy, telemetry config, runtime config, and dependencies. This makes agents discoverable and auditable.
2. **Deploy telemetry as a reusable action.** The `.github/actions/emit-deploy-telemetry/action.yml` composite action can be dropped into any workflow to emit `deploy.started`, `deploy.success`, or `deploy.failed` events. Non-blocking design means it never fails a deployment.
3. **Retroactive Cloud Run labeling.** The `phase2c-audit-cloud-run.sh` script can audit all existing Cloud Run services, infer their VTID/layer/module from naming patterns, and apply labels + env vars. This bridges the gap between existing unlabeled services and the new governance requirements.
4. **Scaffolding before migration.** Phase 2C created the directory structure (`packages/openapi/`, `skills/`, `tasks/`, `docs/decisions/`) and the ADR (ADR-001) documenting the canonical repo layout, but deferred actual file moves to Phase 2D. This separates the "agree on structure" decision from the risky "move files" operation.

**What was built:** 13 files total. 4 agent manifests, 2 CI workflows, 1 composite action, 1 audit script, 1 ADR, 4 directory READMEs.

## Cross-Phase Patterns

### 1. Additive, Non-Breaking Changes
Every phase was explicitly designed to be non-breaking. Phase 2A added new endpoints. Phase 2B added CI checks (existing code continues to work). Phase 2C added manifests and telemetry (services run without them, CI enforces for new ones). This additive-only approach reflects GOV-MIGRATION-001 (additive SQL) applied to infrastructure.

### 2. OASIS as Single Source of Truth
All three phases converge on OASIS. Phase 2A pipes events into it. Phase 2B documents the APIs that serve it. Phase 2C ensures every deployment and agent boot emits events to it. By the end of 2C, OASIS has visibility into: GitHub CI/CD, Cloud Run deployments, agent lifecycles, and service health.

### 3. Gradual Enforcement
Phase 2 followed a pattern of "document, then scaffold, then enforce":
- 2A: Build the observation infrastructure
- 2B: Define the rules and enforce in CI
- 2C: Make the rules self-describing in manifests and telemetry

### 4. CEO-Gated Deployment
A recurring pattern: Claude (the autonomous agent) writes all the code, but deployment requires CEO action. This reflects GOV-AGENT-001 (Claude Operational Protocol) where Claude proposes but does not independently deploy.

## What Phase 2 Enabled

The infrastructure built in Phase 2 directly enables later capabilities:

- **Self-Healing System** uses OASIS events for correlation (Layer 6 of diagnosis), the health endpoint requirement (GOV-API-002) for monitoring, and the deploy governance (EXEC-DEPLOY.yml) for fix deployment.
- **Autopilot Recommendation Engine** (VTID-01185) uses OASIS event analysis to detect error patterns and slow endpoints.
- **Agent Architecture** relies on manifests (2C) for service identity, heartbeat utility (2A) for liveness, and KB skills for context-aware execution.

## Timeline

| Date | Event |
|------|-------|
| 2025-10-29 | Phase 2A code complete (deployment pending) |
| 2025-10-29 | Phase 2B code complete (ready for merge) |
| 2025-10-29 | Phase 2C code complete (ready for merge) |

All three phases were produced on the same date, suggesting a concentrated sprint of autonomous engineering by Claude.

## What Comes Next

- **Phase 2D (Monorepo Consolidation):** Move specs to packages/openapi, implement MCP services with manifests, complete the canonical repo structure from ADR-001.
- **Ongoing:** Apply VTID labels to all existing Cloud Run services, update deploy scripts to use telemetry action, implement agent boot telemetry.

## Related Pages

- [[self-healing-system]] -- Enabled by Phase 2 infrastructure
- [[spec-governance]] -- Governance rules established in Phase 2B
- [[agent-architecture]] -- Agent manifests from Phase 2C
- [[memory-indexer]] -- One of the 4 services that received manifests
- [[vitana-orchestrator]] -- Verification engine using OASIS events
- [[summary-phase2-progress]] -- Detailed source summary

## Sources

- `raw/phase-summaries/PHASE2-EXECUTION-SUMMARY.md`
- `raw/phase-summaries/PHASE2-PROGRESS.md`
- `raw/phase-summaries/PHASE2B-EXECUTION-SUMMARY.md`
- `raw/phase-summaries/PHASE2C-EXECUTION-SUMMARY.md`

## Last Updated

2026-04-12
