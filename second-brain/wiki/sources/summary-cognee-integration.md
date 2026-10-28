# Summary: Cognee Integration Design

> Summary of the Cognee Integration Design document (VTID-01225), which specifies how Cognee is integrated as a stateless entity extraction engine processing ORB voice transcripts into Vitana's relationship graph.

## Content

### Document Purpose

This document (`cognee-integration-design.md`) defines the complete architecture for integrating Cognee into Vitana's memory infrastructure. It covers design constraints, service architecture, entity/relationship mapping, implementation code, deployment configuration, security model, and rollback plan.

### VTID and Status

- **VTID**: VTID-01225
- **Status**: Implementation
- **Migration**: `20260201000000_vtid_01225_cognee_extractor.sql`

### Critical Design Constraints

| Constraint | Rationale |
|------------|-----------|
| No Cognee EBAC | Cognee's permission system forces specific backends; Vitana ContextLens handles isolation |
| Dataset per Tenant | Per-user would explode dataset count; use `tenant_{tenant_id}` with session metadata |
| Default Graph Store | Use Cognee defaults (LanceDB vectors, Kuzu graph) for POC; real persistence in Vitana |
| Advisory outputs | Cognee extractions require validation before Vitana persistence |

### Three-Phase Architecture

**Phase 1 -- Cognee Extractor Service** (`services/agents/cognee-extractor/`):
- Python FastAPI Cloud Run service (stateless)
- Input: transcript, tenant_id, user_id, session_id
- Processing: `cognee.add()` -> `cognee.cognify()` -> normalize -> prune dataset
- Output: entities[], relationships[], signals[]
- Config: 0-5 instances, 2 CPU / 4GB RAM, 10 concurrency, 60s timeout

**Phase 2 -- Vitana Gateway Integration** (`POST /api/v1/relationships/from-cognee`):
- Validates ContextLens (tenant_id, user_id match)
- Creates/gets nodes via `relationship_ensure_node()` RPC
- Creates edges via `relationship_add_edge()` RPC with `origin='autopilot'`
- Updates signals via `relationship_update_signal()` RPC
- Full RLS enforcement and OASIS event emission

**Phase 3 -- ORB Live Integration** (added to `orb-live.ts`):
- Fire-and-forget call after each complete user turn
- Non-blocking: extraction failure never fails the conversation
- Uses user's auth token for RLS enforcement on persistence

### Entity and Relationship Mapping

Six Cognee entity types map to Vitana node types (Person->person, Organization->group, Event->event, Location->location, Product->product, Service->service). Seven relationship types map to Vitana relationship_types (KNOWS->friend, WORKS_FOR->member, etc.).

### Signal Extraction

The document defines behavioral signal extraction from transcript text:
- Social preferences (small groups, 1:1)
- Activity preferences (walking, hiking, coffee meetups, online, video)
- Domain interest intensity from entity count analysis

### Security Model

Five security layers: dataset-per-tenant scoping, Supabase RPC with RLS, origin tracking on all edges, ContextLens token validation, and tenant/user ID matching between payload and auth context.

### OASIS Monitoring

Four event types: `cognee.extraction.completed`, `cognee.extraction.timeout`, `cognee.extraction.persisted`, `cognee.extraction.error`.

### Rollback Plan

1. Set `COGNEE_EXTRACTOR_URL=""` to disable
2. Existing memory unaffected
3. Cognee-originated data identifiable and removable via `origin` + `context` fields

### Go/No-Go Checklist

Seven items: extractor deployed, gateway endpoint deployed, ORB integration merged, OASIS events appearing, test extraction valid, RLS verified, rollback tested.

## Related Pages

- [[cognee-integration]]
- [[cognee]]
- [[autonomous-execution]]
- [[summary-autonomous-architecture]]

## Sources

- `raw/autonomy/cognee-integration-design.md`

## Last Updated

2026-04-12
