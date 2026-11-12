# Destination Lifecycle and Operations V1

**Status:** Operational design baseline; lifecycle gates to be finalized. **Version:** 0.1.

## 1. Purpose
Define how a destination moves from draft through validation, publication, operation, change, suspension and archival. A destination remains maintainable after initial AI creation; desired configuration, runtime, integrations, knowledge and health are observable and recoverable.

## 2. Lifecycle principles
State is explicit and auditable; desired state differs from observed runtime; published versions are pinned to revisions; validation precedes publication; changes are versioned/recoverable; external dependencies monitored; suspension/archive preserve required audit records.

## 3. Proposed states
Draft → Configuring → Validating → Ready → Published → Suspended → Archived. These are candidate labels, not final state machine. Distinguish destination lifecycle from deployment, connector and capability health. A destination may be published while a non-critical capability is degraded.

## 4. Readiness
Evaluate identity/ownership, brand/content, knowledge, capabilities, integrations, access/governance, legal/commercial requirements and runtime/domain/accessibility. Optional missing capabilities do not block unrelated destinations. Mandatory failures block readiness. Report blockers, warnings, not applicable and not assessed distinctly.

## 5. Validation and publication
Validate Skeleton schema/semantics; tenant/ownership; permissions/policies; component/capability compatibility; source/knowledge; content/routes; security/privacy; legal approvals; runtime/user journeys; cost/provider dependencies.

Publishing pins exact revision, builds/configures runtime artifact, verifies dependencies and permissions, runs checks, promotes through authorized release process, records release/revision/actor/time/evidence and verifies the published experience. A successful build is not proof of successful live operation. Production publication follows existing authorization controls.

## 6. Change management
Changes originate from participant, external agent, source sync, content, component/archetype upgrade, policy or platform maintenance. Material changes create a new Skeleton/resource revision and impact summary. Detect concurrent edits; never overwrite a newer participant revision with stale AI output.

## 7. Rollback
Restore a previously valid revision where compatible. Check schema/component compatibility, content versions, source grants, migrations and current user data. A configuration rollback cannot reverse payment, booking, message or other external side effect; use provider-supported remediation separately.

## 8. Runtime operations
Monitor availability, page performance, errors, domain/certificates, components, AI interaction, connector health, knowledge freshness, capability health, security events, usage and costs. Show health at destination and capability level; degrade gracefully.

## 9. Connected-source updates
Distinguish routine content refresh, material public content changes, operational data refresh, confirmation-required changes and revoked access. Never automatically publish newly inferred legal, medical or pricing claims without required review.

## 10. Suspension and archival
Suspension may follow owner request, security/fraud, legal requirement, ownership dispute, unsafe behavior, platform integrity issue or contractual conditions. Define scope and reason; preserve audit; provide appeal/reinstatement where appropriate.

Archival covers public visibility/routes, export, retention/deletion, disconnection, credential revocation, subscription termination, outstanding obligations, audit and reinstatement. Subscription expiry alone must not cause uncontrolled data deletion.

## 11. Control Center and agents
Human Control Center exposes lifecycle, revisions, validation, connections, knowledge freshness, capability health, AI task history, usage/cost, trust and access events. Agents operate the same domain functions through Gateway contracts. UI and API enforce identical policy.

## 12. Service operations
Define SLOs by capability class, incident severity, detection, communication, recovery and escalation. Exact contractual service levels remain open.

## 13. Acceptance criteria
Explicit lifecycle and transitions; draft/published revisions distinct; evidence-based validation; publication pinned to validated revision; runtime health separate; conflict-aware changes; rollback limitations explicit; sources monitored; suspension scoped/audited; archive includes data/credentials/billing; UI/agent policies identical.

## 14. Open decisions
Final state machine; environments; deployment runtime; revision/release relation; rollback/migration compatibility; SLOs/support; suspension/appeals; export/deletion/retention; subscription expiry/continuity.

**Guardrail:** map existing release, deployment, monitoring and governance systems. Do not create an independent production pipeline or bypass current release controls.