# ADR-003: One versioned canonical model; partners map once; read-models stay authoritative

**Status:** Accepted (Phase 0, VTID-03532, 2026-08-08)

## Context
Partners must not need point-to-point integrations. The brief requires a
canonical model with versioning, provenance, jurisdiction, classification,
and mapping confidence.

## Decision
- Canonical records use a common envelope: `schema_version` (semver),
  `tenant_id`, `entity_type`, source identity, provenance, `jurisdiction`,
  `data_classification`, `mapping_confidence`, validity window.
- Zod schemas in `services/vcaop/src/canonical/` are the single source of
  truth; Prisma models persist canonical state and mappings
  (`SchemaSource`, `SchemaMapping`, `MappingDecision`).
- Existing commerce tables (`cart_order`, `commission_event`,
  `rewards_ledger`, …) remain the authoritative read-models; canonical
  records reference them rather than duplicating state.
- Compatibility: additive = minor version (normalizer up-converts);
  breaking = new major with a dual-write window. Consumers declare the major
  they read.
- Health-classified entities get separate storage and access policy and are
  excluded from general query paths (Phase 7 only).

## Consequences
- Cross-partner flows are always canonical-mediated.
- Every mapping is a versioned, reviewable row with confidence; low
  confidence can never silently activate (enforced in the certification
  pipeline, tested).
