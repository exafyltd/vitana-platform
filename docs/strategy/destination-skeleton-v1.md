# Destination Skeleton V1 — Detailed Specification

**Parent framework:** Vitanaland AI-Native Destination Framework V1  
**Specification status:** Detailed design baseline — requirements and contracts to be refined before implementation  
**Version:** 0.1  
**Date:** 2026-11-12  
**Repository:** `exafyltd/vitana-platform`  
**Parent document:** `docs/strategy/VITANALAND-AI-NATIVE-DESTINATION-FRAMEWORK-V1.md`

---

## 1. Purpose

The Destination Skeleton is the canonical, machine-readable structural contract for every destination in Vitanaland.

It defines what a destination is, how it is identified and owned, how its experience is composed, which capabilities it exposes, what knowledge and connected sources it uses, how it is governed, and how it moves through its lifecycle.

The Skeleton is the common contract consumed by:
- Vitanaland Business Builder.
- Vitana AI and its execution/orchestration services.
- Vitanaland Agent Gateway and external AI agents.
- Destination rendering and experience runtime.
- Integration Fabric and Connected Sources.
- Identity, tenancy, access and governance services.
- Discovery, marketplace, trust and Vitana Index services.
- Destination Control Center and authorized operators.

The Skeleton must make destinations consistent at the platform-contract level without making them visually or operationally identical.

**Core principle:** standardize the structure and capabilities required to participate in Vitanaland; preserve each destination's independent identity, purpose, ownership and experience.

This specification describes the target contract. It does not claim that this schema or all supporting services already exist.

## 2. Design principles

### 2.1 One destination contract

Every destination, regardless of archetype or participant type, is represented through the same top-level contract. Specialized destination types extend the common contract through optional modules and capability declarations; they do not create unrelated data models.

### 2.2 Modular composition

A destination is composed from modules. The platform can add, remove, upgrade or replace a module without requiring a rebuild of the entire destination, subject to compatibility and dependency rules.

### 2.3 Explicit identity and ownership

Every destination has a stable identifier, tenant/organization context, owner relationship and lifecycle state. Ownership must never be inferred from a domain name, connected account or content source.

### 2.4 Configuration is not execution

The Skeleton describes desired state and references capabilities, content, sources and policies. It is not itself an execution engine, connector runtime, database of every business transaction or authorization bypass.

Actual operations are performed by the relevant platform services and authorized integrations.

### 2.5 Desired state and observed state

The Skeleton records the intended destination configuration. Runtime systems separately report observed state: what is deployed, connected, healthy, synchronized, published or failing.

A difference between desired and observed state must be detectable and explainable.

### 2.6 AI-readable and human-governable

The contract must be structured and unambiguous enough for AI agents and automation to reason over, while remaining inspectable and understandable through a human control interface.

### 2.7 Tenant-safe by default

All tenant-owned modules and references must carry or inherit an explicit tenant and ownership scope. Shared ecosystem modules must be clearly marked as shared and governed by platform policy.

### 2.8 Versioned and evolvable

The schema must support explicit versions, compatibility rules, migrations and validation. A schema update must not silently reinterpret existing destinations.

### 2.9 Provider-agnostic

The Skeleton references capabilities and logical connections, not assumptions that a particular vendor is the only provider. Provider-specific details belong in connector configuration managed by the Integration Fabric.

## 3. Scope and boundaries

### 3.1 The Skeleton owns

The Skeleton owns the destination's declarative structure:
- Destination identity and classification.
- Tenant, organization and ownership references.
- Brand and experience configuration references.
- Archetype and composition.
- Page, section and navigation definitions.
- Component and extension references.
- Content and localization references.
- Capability declarations and bindings.
- Connected-source and integration references.
- Knowledge configuration and scope references.
- Vitana AI behavior/configuration references.
- Membership, role and access-policy references.
- Trust and Vitana Index associations.
- Lifecycle, version and publishing intent.
- Validation and compatibility metadata.

### 3.2 The Skeleton does not own

The Skeleton is not the authoritative store for:
- User credentials, passwords, OAuth tokens, API keys or secrets.
- Full customer, patient or employee records.
- Payment card or bank credentials.
- Orders, bookings, appointments or inventory transaction ledgers.
- Raw document binaries, media files or entire crawled websites.
- Vector embeddings or the full knowledge index.
- Connector execution state and provider tokens.
- AI conversation transcripts or personal memory.
- Detailed audit event streams.
- Billing ledger entries or credit balances.
- The Vitana Index calculation engine or its raw evidence store.

The Skeleton may reference these resources through stable, authorized service identifiers. It must not duplicate sensitive operational data simply to make a destination self-contained.

### 3.3 Separation of concerns

| Concern | Authoritative owner |
|---|---|
| Destination structure and composition | Destination Skeleton service |
| Tenant and organization identity | Identity / tenancy service |
| Credentials and secrets | Secure credential/connection service |
| Connector execution and synchronization | Integration Fabric |
| Source documents and media | Content/source storage services |
| Knowledge extraction and retrieval | Knowledge Builder / knowledge services |
| AI model selection and execution | Vitana AI execution platform |
| External-agent access | Agent Gateway and authorization services |
| Orders, bookings and operational records | Connected business systems or designated Vitanaland capability services |
| Vitana Index methodology and scores | Vitana Index service |
| Audit history | Platform audit/governance services |
| Subscription and credit accounting | Commercial/billing services |

The exact service boundaries must be reconciled with the existing platform before implementation.

## 4. Destination identity and ownership model

Every destination must have a stable platform identifier that does not depend on its display name, domain, URL or external provider.

Minimum conceptual identity fields:

- `destination_id`: immutable platform identifier.
- `tenant_id`: tenant security boundary.
- `organization_id`: owning or operating organization, when applicable.
- `owner_subject_id`: accountable owner subject or principal.
- `name`: human-readable destination name.
- `slug`: human-readable route/discovery key, subject to uniqueness rules.
- `destination_type`: broad classification, such as business, professional, community, creator or ecosystem.
- `archetype_id`: experience composition starting point.
- `status`: lifecycle state.
- `created_at`, `updated_at`: timestamps.
- `schema_version`: version of the Skeleton contract.
- `revision`: monotonically increasing destination configuration revision.

Identity and tenancy rules:
1. A destination belongs to exactly one tenant security boundary.
2. A destination may be associated with an organization and one or more authorized operating principals.
3. A person may participate in multiple organizations and destinations without merging their tenant data.
4. A domain or connected social account is a source or route claim, not proof of ownership.
5. Ownership transfer is a governed operation with explicit verification and audit.
6. Display names and slugs may change; the stable destination identifier does not.
7. Cross-tenant relationships must be represented as explicit, authorized relationships, never by copying private tenant data into another destination.

The platform must decide whether a tenant maps one-to-one to an organization or supports multiple organizations per tenant. This is an open tenancy design decision and must align with the active multi-tenancy architecture rather than being decided independently here.

## 5. Logical Skeleton structure

The following is a conceptual structure, not a final JSON Schema or database schema:

```yaml
schema_version: "1.0"
revision: 1

identity:
  destination_id: "stable-id"
  tenant_id: "tenant-id"
  organization_id: "organization-id"
  owner_subject_id: "subject-id"
  name: "Destination name"
  slug: "destination-slug"
  destination_type: "business"
  archetype_id: "company-experience"
  status: "draft"

brand:
  brand_profile_ref: "brand-profile-id"
  design_system_ref: "design-system-id"
  identity_assets_ref: "asset-collection-id"
  locale_defaults: ["en"]

experience:
  navigation_ref: "navigation-id"
  page_composition_refs: []
  component_registry_version: "version"

content:
  content_collection_refs: []
  localization_ref: "localization-id"

capabilities:
  declared: []
  bindings: []

connected_sources:
  source_refs: []

knowledge:
  knowledge_space_ref: "knowledge-space-id"
  scopes: []

vitana_ai:
  assistant_profile_ref: "assistant-profile-id"
  behavior_policy_ref: "policy-id"

access:
  membership_policy_ref: "policy-id"
  role_set_ref: "role-set-id"

trust:
  index_associations: []
  verification_profile_ref: "verification-profile-id"

governance:
  policy_refs: []
  data_classification_profile_ref: "classification-profile-id"

lifecycle:
  desired_state: "draft"
  published_revision: null
  release_ref: null

metadata:
  created_at: "timestamp"
  updated_at: "timestamp"
  created_by: "subject-id"
  updated_by: "subject-id"
```

This example illustrates module boundaries only. Field names, requiredness, types, enums, reference formats and schema technology require a formal schema-design pass.

## 6. Core modules

### 6.1 Identity and ownership module

Purpose: establish the destination's stable identity and accountable ownership.

Requirements:
- Stable, immutable destination ID.
- Explicit tenant and owner references.
- Optional organization association governed by tenancy rules.
- Destination type and archetype references.
- Creation and update provenance.
- Verified ownership/claim status where relevant.
- Controlled ownership and operator changes.

The module must distinguish:
- Legal or accountable owner.
- Organization that operates the destination.
- Individual users with administrative access.
- External agents delegated to perform specific actions.

These roles may overlap but must not be collapsed into one field.

### 6.2 Brand and design module

Purpose: preserve destination-specific identity while enabling reusable rendering infrastructure.

References may include:
- Brand name and positioning.
- Logo and approved identity assets.
- Color, typography and design tokens.
- Image/video treatment.
- Tone and voice guidance.
- Accessibility preferences.
- Locale and language defaults.

The Skeleton should reference versioned brand/design resources rather than embedding all assets and design tokens inline.

A shared component library must not force a shared visual identity. Component behavior and accessibility can be standardized while visual presentation remains destination-configurable.

### 6.3 Archetype module

Purpose: provide an initial structural composition appropriate to the destination's purpose.

Candidate archetypes:
- Ecosystem/world experience.
- Company/business experience.
- Community experience.
- Professional/provider experience.
- Creator/individual experience.
- Mission or movement experience.

An archetype is a starting composition and a set of recommended defaults, not a restrictive product category. Destinations may compose capabilities and sections from multiple archetypes.

Archetype definitions should specify:
- Intended use and audience.
- Recommended pages and section patterns.
- Recommended capabilities.
- Optional modules.
- Required minimum content.
- Compatibility constraints.
- Version and migration behavior.

Changing an archetype must not erase participant content or silently remove active capabilities.

### 6.4 Experience composition module

Purpose: describe how a destination's visitor-facing experience is assembled.

It references:
- Pages and routes.
- Navigation hierarchy.
- Sections and their order.
- Components used within sections.
- Responsive and accessibility behavior.
- Dynamic/personalized presentation rules.
- Publishing and visibility configuration.

The model should support:
- A first-section AI-native hero/Intelligence Gateway.
- Conventional scrollable storytelling sections.
- Indexable, accessible content pages.
- Destination-specific layouts.
- Dynamically assembled AI presentations using approved content.
- Multiple channels or presentation surfaces where required.

The hero AI gateway is a reusable pattern, not a requirement that the entire destination becomes a chatbot.

Pages and sections should be composable and reusable. A section definition should reference a component and its configuration rather than embed arbitrary executable code.

### 6.5 Component and extension module

Purpose: identify approved building blocks and extensions used by the destination.

Each component reference should identify:
- Component type and stable identifier.
- Component version.
- Configuration schema/version.
- Required capabilities.
- Data inputs and outputs.
- Permission requirements.
- Compatibility constraints.
- Rendering/runtime requirements.

Only approved, versioned components may be activated. Arbitrary code must not be executable merely because a destination manifest references it.

Extensions must be permission-scoped and subject to compatibility, security and lifecycle validation.

### 6.6 Content and localization module

Purpose: connect the destination to its approved content and language resources.

The Skeleton references content collections, pages, media and localization resources. Content records remain in their authoritative content services.

Requirements:
- Multiple languages and locale fallback.
- Content ownership and source provenance.
- Draft, review and published states.
- Revision history.
- Content visibility and access scope.
- Search/indexing metadata.
- Accessibility metadata for media and content.
- Explicit distinction between participant-authored, imported and AI-generated content.

AI-generated content must not automatically become published content where approval is required by destination policy.

### 6.7 Capabilities module

Purpose: declare what the destination can do, independently of which vendor or provider implements it.

A capability declaration should identify:
- Capability namespace and name.
- Contract/version.
- Whether it is available, planned, disabled or degraded.
- Required permissions/scopes.
- Input/output contract reference.
- Provider binding reference, if connected.
- Operational policy and limits.
- Availability/health reference.

Candidate capability families include:
- Discovery and information.
- Contact and communication.
- Product catalogue.
- Pricing and offers.
- Inventory.
- Orders and checkout.
- Payments.
- Bookings and appointments.
- Events and registration.
- Membership and subscriptions.
- Delivery/fulfilment.
- Customer relationship management.
- Professional service delivery.
- Analytics and reporting.

The list is illustrative and must be developed through a capability taxonomy exercise.

A declared capability is not proof that it is operational. Runtime health and verification must establish whether it is actually available.

### 6.8 Connected Sources module

Purpose: reference the authorized sources and integrations contributing knowledge or operational capabilities.

The Skeleton should reference connection records managed by the Integration Fabric. It must not contain OAuth tokens, API keys or other secrets.

For each source reference, the platform should be able to resolve:
- Source/connection ID.
- Source category and provider.
- Tenant and destination ownership scope.
- Granted scopes and consent record.
- Capabilities supplied by the source.
- Data synchronization mode.
- Last successful synchronization and health.
- Revocation and disconnection state.

A website source may contribute public knowledge without enabling transactions. A business-system connection may provide live operational capabilities. These must be represented distinctly.

### 6.9 Knowledge module

Purpose: define which knowledge spaces and scopes Vitana AI may use when representing the destination.

References may include:
- Destination knowledge space.
- Universal Vitanaland knowledge policy.
- Approved destination-specific knowledge collections.
- Connected-source knowledge scopes.
- Freshness and refresh policy.
- Retrieval permissions.
- Source and confidence requirements.
- Confirmation status requirements.

The Skeleton must not store raw embeddings or entire knowledge corpora. Those belong to the knowledge service.

The knowledge module must preserve separation between source information, AI interpretation and confirmed facts.

### 6.10 Vitana AI module

Purpose: configure how Vitana AI represents and assists the destination.

References may include:
- Assistant/agent profile.
- Destination-specific tone, language and identity.
- Knowledge scopes.
- Allowed capability set.
- Interaction surfaces.
- Escalation and human handoff policy.
- Approval requirements.
- Model policy reference.
- Usage/budget policy reference.

This module configures destination-aware behavior. It does not create a separate universal Vitana AI for every destination. The universal Vitana AI identity and personal-companion role remain shared, while destination-specific context and permissions are applied when appropriate.

### 6.11 Access and membership module

Purpose: define how people and delegated agents access destination resources and capabilities.

It references:
- Membership model.
- Roles and role definitions.
- Access policies.
- Public/private content rules.
- Subscription or entitlement references.
- Delegation policy.
- Agent permission policy.

Roles and policies must be enforced by the authorization service. A role label in the Skeleton is not itself an authorization decision.

### 6.12 Trust and Vitana Index module

Purpose: associate a destination with relevant trust, verification and index services.

It may reference:
- Destination verification status.
- Location Vitana Index profile.
- Provider associations.
- Evidence categories.
- Trust policy.
- Appeals or review status.

The Skeleton does not calculate or store the authoritative score. The Vitana Index service owns methodology, evidence processing and score history.

### 6.13 Governance and data classification module

Purpose: attach applicable platform and destination policies.

Policy references may cover:
- Privacy and data classification.
- Retention and deletion.
- Consent and source authorization.
- Agent delegation.
- Publishing approvals.
- Financial approvals.
- Sensitive-data handling.
- Audit requirements.
- Regulatory or jurisdictional constraints.

Destination-specific policies may tighten platform defaults but must not weaken mandatory platform controls.

### 6.14 Lifecycle and publishing module

Purpose: describe desired lifecycle state and publication intent.

Candidate lifecycle states:
- `draft`
- `configuring`
- `validating`
- `ready`
- `published`
- `suspended`
- `archived`

The final state machine, transition rules and role permissions must be specified separately. These labels are proposed, not finalized.

The module should track:
- Current desired state.
- Current observed state reference.
- Current configuration revision.
- Published revision.
- Release/deployment reference.
- Validation result reference.
- Publication timestamp and actor.
- Suspension reason where applicable.

A destination may be structurally valid but not publishable because a required capability, verification, policy or approval is missing.

## 7. Archetypes and composition rules

Archetypes provide defaults; modules provide composition.

Rules:
1. Every destination uses the common Skeleton contract.
2. Every destination has one primary archetype at a given revision.
3. A destination may use compatible patterns and modules from other archetypes.
4. Required modules are determined by the destination's declared capabilities and policies, not only by its archetype.
5. Optional modules can be added without changing the destination's stable identity.
6. Removing a module requires dependency checks and an impact report.
7. Archetype updates must be versioned and must not overwrite participant-owned content.
8. Archetypes cannot bypass tenant isolation, permissions or governance.

## 8. References, dependencies and integrity

Modules should reference authoritative resources by stable IDs and explicit versions where compatibility matters.

Validation must detect:
- Missing referenced resources.
- Invalid or inaccessible tenant references.
- Incompatible schema or component versions.
- Missing required capability bindings.
- Circular or invalid composition dependencies.
- Duplicate routes or conflicting navigation.
- Unsupported locale configuration.
- Revoked or expired source connections.
- Policies that conflict with mandatory platform policy.
- Components requesting permissions not granted by the destination.
- Published content that references unavailable components.

A reference being syntactically valid does not prove the caller is authorized to resolve it. Authorization must be enforced at every service boundary.

## 9. Desired state, observed state and reconciliation

The Skeleton is the destination's desired configuration. Runtime systems report observed state.

Examples of observed state:
- Website/runtime release deployed.
- Page successfully rendered.
- Connector authorized and healthy.
- Source synchronization current or stale.
- Knowledge index processed.
- Capability available or degraded.
- Domain verified.
- Destination publication active or suspended.

The platform should provide reconciliation:
1. Read the current desired revision.
2. Read relevant observed state from owning services.
3. Compare expected and actual configuration.
4. Identify drift, failures or missing prerequisites.
5. Produce an actionable explanation.
6. Propose or execute an authorized correction.
7. Record the outcome and resulting revision/state.

Reconciliation must be idempotent where possible. It must not silently overwrite participant changes or take consequential actions outside granted permissions.

## 10. Validation model

Validation should be layered.

### 10.1 Schema validation

- Required fields present.
- Types, formats and enumerations valid.
- Schema version supported.
- Module structure conforms to contract.

### 10.2 Semantic validation

- Identity and ownership references consistent.
- Archetype and modules compatible.
- Pages and navigation structurally valid.
- Capabilities coherent with destination type and declared offerings.
- Knowledge scopes and assistant configuration consistent.
- Policies and access rules coherent.

### 10.3 Dependency validation

- All required references resolve.
- Component and capability versions are compatible.
- Required connections exist and are authorized.
- No forbidden dependency cycles exist.

### 10.4 Security and governance validation

- Tenant boundaries valid.
- Permission scopes least-privilege.
- No secrets embedded in the Skeleton.
- Sensitive data classifications and policies present.
- External publishing and financial actions have required approvals.
- No unauthorized cross-tenant references.

### 10.5 Runtime readiness validation

- Required components available.
- Required integrations healthy.
- Required knowledge processing complete.
- Required domains and routes verified.
- Critical user journeys pass tests.
- Required trust/verification checks complete.

Validation results should be machine-readable and explainable, with severity, affected module, evidence, remediation guidance and timestamp.

## 11. Revisioning and schema evolution

Two version concepts must remain distinct:

1. **Schema version:** the version of the Destination Skeleton contract.
2. **Destination revision:** a particular revision of one destination's configuration.

Every material configuration change creates a new destination revision. Schema evolution must define:
- Backward-compatible additions.
- Deprecated fields and migration windows.
- Breaking changes and explicit migrations.
- Defaulting behavior.
- Rollback behavior.
- Compatibility between component, capability and schema versions.

Never silently rewrite historical revisions. A migration should be repeatable, observable and recoverable. Migration behavior must be designed to avoid disrupting the ongoing multi-tenancy work and existing platform records.

## 12. Security requirements

- Enforce tenant isolation in the service/data layer, not only in presentation.
- Do not store credentials or secrets in the Skeleton.
- Resolve references only after authorization checks.
- Validate all agent-initiated changes against the caller's delegated scopes.
- Prevent untrusted source content from becoming executable configuration.
- Treat imported content and AI-generated proposals as untrusted until validated.
- Require explicit approvals for ownership, sensitive-data, financial and external-publishing changes.
- Log actor, agent, tenant, destination, action, revision and result.
- Support revocation of connected sources and delegated agent access.
- Avoid leaking private destination structure through public discovery endpoints.

## 13. AI authoring and change workflow

The Business Builder and authorized agents should interact with the Skeleton through controlled operations, not arbitrary database writes.

Conceptual workflow:
1. Agent receives participant intent.
2. Agent discovers the destination contract and allowed operations.
3. Agent reads the authorized current revision.
4. Agent proposes a structured change set.
5. Platform validates schema, semantics, dependencies, policy and permissions.
6. Participant approval is requested when required.
7. Authorized execution applies the change as a new revision.
8. Relevant services reconcile desired state.
9. Verification confirms the resulting destination behavior.
10. The agent reports changes, unresolved items and any cost/usage.

A change set should support preview, validation, approval, apply and rollback/recovery. The exact API and transaction model remain to be designed.

## 14. Observability and audit

For every revision and consequential operation, the platform should be able to answer:
- Who or which agent initiated the change?
- On whose behalf?
- Which tenant and destination were affected?
- Which revision was read and which was created?
- Which modules changed?
- Which permissions and approvals were used?
- Which validation checks ran?
- What changed in observed runtime state?
- Did execution succeed, fail or partially complete?
- What recovery action was taken?

The Skeleton should reference audit records rather than embed the full audit stream.

## 15. Acceptance criteria for Destination Skeleton V1

The specification is ready to move toward implementation planning when:

1. One canonical contract covers all supported destination archetypes.
2. Stable identity, tenant and ownership semantics are unambiguous.
3. Required and optional modules are defined.
4. Module ownership and service boundaries are documented.
5. Capability declarations are provider-agnostic.
6. Connected-source and knowledge references preserve authorization and provenance.
7. AI configuration is distinct from the universal Vitana AI identity and from execution runtime.
8. Desired state is distinct from observed state.
9. Lifecycle states and transitions are formally defined.
10. Schema versioning and destination revisioning are separate.
11. Validation layers and failure reporting are defined.
12. Tenant isolation and permission enforcement are explicit.
13. The contract can be authored and changed through controlled agent operations.
14. Existing platform services and active multi-tenancy work have been mapped before implementation.
15. A migration and compatibility strategy exists for any existing destination data.

## 16. Open design decisions

The following must be resolved before freezing the contract:

1. Formal schema technology and canonical serialization format.
2. Exact required fields and field-level types.
3. Tenant-to-organization cardinality and ownership semantics, aligned with current multi-tenancy implementation.
4. Destination archetype taxonomy and versioning.
5. Component registry and extension trust model.
6. Page/section composition grammar and rendering contract.
7. Capability namespace, discovery and version compatibility rules.
8. Reference resolution and authorization model.
9. Desired/observed state ownership and reconciliation protocol.
10. Lifecycle state machine and publication gates.
11. Revision transaction, concurrency and rollback model.
12. Localization and content revision model.
13. How personal Vitana AI context is separated from destination knowledge.
14. How index/verification services expose associations without coupling their internal algorithms to the Skeleton.

## 17. Next specification dependencies

This specification is foundational. The next detailed specifications should define:
- Destination Builder: how participants create and modify a Skeleton.
- Integration Fabric: how source and capability references are established.
- Knowledge Builder: how knowledge spaces and provenance are populated.
- Agent Gateway: how external agents discover and change destinations safely.
- UX and Experience Framework: how page and section composition is rendered.
- Multi-Tenancy and Governance: how tenant, owner and permission boundaries are enforced.

## 18. Implementation caution

Do not begin by creating a parallel destination database or a new builder service. First map this contract to the current platform architecture and identify existing services, tables, APIs, policies and active workstreams.

The implementation plan must explicitly identify:
- What already exists and can be reused.
- What is missing.
- What requires extension.
- What must remain unchanged during current multi-tenancy work.
- How compatibility and migration will be protected.
- How the new contract will be introduced incrementally.

No production writes or migrations are authorized by this strategic specification.
