# Cognee Integration

> Cognee is integrated into Vitana as a stateless entity extraction engine that processes ORB voice transcripts and outputs normalized entities and relationships, which are then persisted into Vitana's VTID-01087 relationship graph under full ContextLens governance.

## Content

### Design Philosophy

Cognee is used strictly as an extraction tool, not as a persistence layer. Key constraints:

- **No Cognee EBAC** -- Cognee's permission system (ENABLE_BACKEND_ACCESS_CONTROL) is explicitly disabled because it forces specific default backends and ignores custom providers. Vitana's ContextLens handles all isolation.
- **Dataset per Tenant** -- Uses `dataset_name=tenant_{tenant_id}` to avoid dataset explosion (not per-user). Session metadata handles user separation.
- **Default Graph Store** -- Uses Cognee's default graph store (Kuzu) for POC. All persisted output goes to Vitana's own VTID-01087 tables.
- **Advisory Outputs** -- Cognee extractions require validation before persistence. All Vitana writes are governed and auditable.
- **Stateless** -- Cognee dataset is pruned after each extraction. No long-term storage in Cognee.

### Architecture Flow

```
ORB Live API (orb-live.ts)
    |  Transcript + ContextLens
    v
Cognee Extractor Service (Python Cloud Run, stateless)
    |  cognee.add() -> cognee.cognify() -> normalize to Vitana schema
    v
Vitana Relationship Bridge (gateway: POST /api/v1/relationships/from-cognee)
    |  Validates ContextLens, calls RPCs with RLS, emits OASIS events
    v
Supabase (VTID-01087 Tables)
    relationship_nodes, relationship_edges, relationship_signals
```

### Entity Type Mapping

| Cognee Entity | Vitana node_type |
|---------------|-----------------|
| Person | `person` |
| Organization | `group` |
| Event | `event` |
| Location | `location` |
| Product | `product` |
| Service | `service` |
| Concept | stored as metadata on related nodes |

### Relationship Type Mapping

| Cognee Relationship | Vitana relationship_type |
|--------------------|------------------------|
| KNOWS | `friend` |
| WORKS_FOR | `member` |
| ATTENDS | `attendee` |
| INTERESTED_IN | `interested` |
| USES | `using` |
| LOCATED_IN | `visited` |
| FOLLOWS | `following` |

### Domain Detection

Domains are detected from transcript keywords:
- **health**: health, medical, doctor, symptom, therapy, wellness, hospital
- **business**: business, work, company, meeting, project, office, job
- **lifestyle**: hobby, sport, travel, leisure, fun, vacation, game
- **community**: default fallback

### Signal Extraction

Beyond entities and relationships, the extractor detects behavioral signals from transcripts:
- Social preferences: `prefers_small_groups`, `prefers_individual`
- Activity preferences: `likes_walking`, `likes_hiking`, `likes_coffee_meetups`, `prefers_online`, `prefers_video`
- Domain interest intensity based on entity count per domain (e.g., `health_focused` with confidence scaling)

### Deployment

- **Service**: Python Cloud Run (`cognee-extractor`), min 0 / max 5 instances, 2 CPU / 4GB RAM
- **Concurrency**: 10 requests per container, 60-second timeout
- **Dependencies**: cognee >= 0.5.1, FastAPI, uvicorn, pydantic
- **Integration**: Fire-and-forget from ORB Live -- extraction failure never blocks the conversation

### ORB Live Integration

After each complete user turn in the voice conversation, the ORB calls the Cognee extractor asynchronously (fire-and-forget). If entities or relationships are found, they are persisted to Vitana via the gateway bridge endpoint. Failures are logged but never surface to the user.

### Security

1. No cross-tenant access (dataset-per-tenant scoping)
2. All persistence through Supabase RPCs with RLS enforcement
3. Origin tracking: all edges have `origin='autopilot'` with `context.origin='cognee'`
4. Token validation via ContextLens before accepting output
5. Gateway validates `tenant_id` and `user_id` match authenticated context

### OASIS Monitoring Events

| Event | Description |
|-------|-------------|
| `cognee.extraction.completed` | Extraction finished successfully |
| `cognee.extraction.timeout` | Extraction timed out (30s limit) |
| `cognee.extraction.persisted` | Results written to Supabase |
| `cognee.extraction.error` | Persistence failed |

### Rollback

1. Disable extraction by setting `COGNEE_EXTRACTOR_URL=""` in gateway env
2. Existing memory unaffected (Cognee only adds to relationship graph)
3. Cognee-originated data identifiable via: `SELECT * FROM relationship_edges WHERE origin = 'autopilot' AND context->>'origin' = 'cognee'`

## Related Pages

- [[cognee]]
- [[autopilot-system]]
- [[autopilot-automations]]
- [[autonomous-execution]]

## Sources

- `raw/autonomy/cognee-integration-design.md`

## Last Updated

2026-04-12
