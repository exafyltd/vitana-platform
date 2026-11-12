# Vitanaland AI-Native Destination Framework V1

<details>
<summary>Package status and navigation</summary>

**Status:** Strategic baseline plus 12 detailed domain specifications  
**Version:** 0.1 working package  
**Owner:** Exafy LTD / Vitanaland  
**Branch:** `docs/vitanaland-ai-native-destination-framework-v1`

This folder is the canonical handover point for the V1 framework. Start here, then read the strategic baseline and the 12 specifications in order.

</details>

## Start here

1. [Core Architecture V1](00-core-architecture-v1.md) — system layers, domain boundaries, flows and architecture principles.
2. [Vision and Strategic Baseline](VISION-AND-STRATEGIC-BASELINE.md) — agreed vision, concepts, decisions, open questions and continuation instructions.

## The 12 detailed specifications

| # | Specification | Scope |
|---:|---|---|
| 00 | [Core Architecture](00-core-architecture-v1.md) | Overall architecture, layers, domain boundaries and end-to-end flows |
| 01 | [Destination Skeleton](01-destination-skeleton-v1.md) | Canonical destination contract, modules, ownership, versioning and validation |
| 02 | [Destination Builder](02-destination-builder-v1.md) | AI-native creation and connection of new/existing businesses |
| 03 | [Integration Fabric](03-integration-fabric-v1.md) | Connectors, capability contracts, authorization, sync and operations |
| 04 | [Knowledge Builder](04-knowledge-builder-v1.md) | Websites, documents, social/business sources, provenance and retrieval |
| 05 | [Agent Gateway](05-agent-gateway-v1.md) | External AI agents, MCP/API discovery, delegation and permissions |
| 06 | [Vitana AI Execution Platform](06-vitana-ai-execution-platform-v1.md) | Model routing, planning, orchestration, verification and recovery |
| 07 | [Credits and Commercial Model](07-credits-and-commercial-model-v1.md) | AI credits, subscriptions, external costs and infrastructure modes |
| 08 | [Destination UX and Experience](08-destination-ux-and-experience-v1.md) | Landing pages, ORB, archetypes, storytelling and composable UI |
| 09 | [Trust, Vitana Index and Reputation](09-trust-vitana-index-and-reputation-v1.md) | Human/provider/location index domains, evidence and appeals |
| 10 | [Multi-Tenancy, Security and Governance](10-multi-tenancy-security-and-governance-v1.md) | Tenant isolation, identity, consent, delegation and controls |
| 11 | [Destination Lifecycle and Operations](11-destination-lifecycle-and-operations-v1.md) | Validation, publishing, revisions, monitoring, suspension and archival |

## Reading and decision status

The documents distinguish:
- **Agreed direction:** decisions established during the strategic discussions.
- **Proposed design:** a recommended design direction that still needs validation.
- **Open decision:** a matter that must be resolved before the specification is frozen.
- **Implementation guardrail:** a constraint protecting existing platform work and production systems.

These documents are a strategic and architecture specification package, not proof that every described capability exists in the current platform and not authorization to implement or deploy changes.

## Critical continuation instructions

The next agent should:

1. Read this README and all 12 specifications.
2. Read the existing repository governance and agent instructions before any repository work.
3. Inspect current platform implementation and classify each capability as implemented, partial, planned or conceptual.
4. Map each logical domain to existing services, APIs, schemas, policies and owners.
5. Preserve the active multi-tenancy work and all existing migration work.
6. Reuse the existing Agent Gateway, MCP, Autopilot, Worker Orchestrator, Worker-Runner, VCAOP, Command Hub and verification foundations where applicable.
7. Treat AWS as the current cloud baseline.
8. Never create a parallel identity, tenancy, memory, integration or execution system without evidence and explicit architectural justification.
9. Keep confirmed decisions, proposals and open questions separate.
10. Do not allocate VTIDs manually; follow the repository's allocator and delivery process if implementation is later authorized.
11. Do not perform production writes or migrations based on these documents.

## Recommended next strategic sequence

1. Review and freeze the Destination Skeleton contract.
2. Map the 12 domains to the existing Vitanaland architecture and current multi-tenancy implementation.
3. Resolve cross-cutting open decisions: tenant/organization semantics, capability contracts, agent delegation, knowledge scope and lifecycle/release boundaries.
4. Define MVP boundaries and phased delivery without disrupting active work.
5. Only then produce an implementation plan using the repository's established workflow.

## Document relationships

The Destination Skeleton is the common destination contract. The Builder authors it; Integration Fabric supplies authorized source/capability bindings; Knowledge Builder supplies scoped knowledge references; Agent Gateway governs external agent access; Vitana AI Execution performs approved work; Credits/Commercial governs metering; UX renders the experience; Trust/Index provides quality associations; Multi-Tenancy/Security governs access; Lifecycle/Operations governs validation and runtime state.

The Core Architecture document defines the logical boundaries across all of them.
