# Cognee

> Cognee is an external entity extraction and knowledge graph library integrated into Vitana as a stateless Cloud Run service that processes voice transcripts into structured entities, relationships, and behavioral signals.

## Content

### What Cognee Is

Cognee is a Python library (>= 0.5.1) that provides:
- **Entity extraction** -- Identifies people, organizations, events, locations, products, and services from unstructured text
- **Relationship detection** -- Discovers connections between entities (KNOWS, WORKS_FOR, ATTENDS, INTERESTED_IN, USES, LOCATED_IN, FOLLOWS)
- **Knowledge graph generation** -- `cognee.add()` ingests text, `cognee.cognify()` builds the graph, `cognee.search()` queries it

### What Cognee Provides to Vitana

Cognee serves as the extraction engine for Vitana's memory and relationship intelligence:

1. **ORB voice transcript processing** -- After each user turn in an ORB conversation, the transcript is sent to Cognee for entity extraction
2. **Normalized output** -- Cognee's raw entity types are mapped to Vitana's node types (Person -> `person`, Organization -> `group`, Event -> `event`, etc.)
3. **Behavioral signals** -- Beyond entities, the extractor detects social preferences and activity preferences from transcript patterns
4. **Relationship graph enrichment** -- Extracted relationships feed into Vitana's VTID-01087 relationship tables (`relationship_nodes`, `relationship_edges`, `relationship_signals`)

### How It Connects to Vitana

**Deployment**: Stateless Python Cloud Run service (`cognee-extractor`) at `services/agents/cognee-extractor/`

**Integration path**:
```
ORB Live API -> Cognee Extractor Service -> Vitana Gateway Bridge -> Supabase (VTID-01087)
```

**Key design decisions**:
- Cognee's EBAC (backend access control) is disabled -- Vitana's ContextLens handles all tenant/user isolation
- Dataset scoped per tenant (not per user) to avoid scalability issues
- Default storage backends used (LanceDB for vectors, Kuzu for graph) -- these are ephemeral since dataset is pruned after each extraction
- Fire-and-forget integration -- extraction failure never blocks the ORB conversation
- 30-second timeout per extraction request

**VTID**: VTID-01225 (Implementation status)

**Migration**: `20260201000000_vtid_01225_cognee_extractor.sql`

### Configuration

| Variable | Value | Notes |
|----------|-------|-------|
| `COGNEE_EXTRACTOR_URL` | Cloud Run URL | Set in gateway env; empty string disables extraction |
| `LLM_API_KEY` | API key | For Cognee's internal LLM (entity extraction) |
| `LLM_PROVIDER` | openai or vertex_ai | Provider for extraction LLM |
| `LLM_MODEL` | gpt-4o-mini or gemini-2.0-flash-exp | Model for extraction |
| `ENABLE_BACKEND_ACCESS_CONTROL` | NOT SET (disabled) | Explicitly not configured |

### Monitoring

All Cognee activity is tracked via OASIS events:
- `cognee.extraction.completed` -- Successful extraction with entity/relationship/signal counts
- `cognee.extraction.timeout` -- 30-second timeout exceeded
- `cognee.extraction.persisted` -- Results successfully written to Supabase
- `cognee.extraction.error` -- Persistence failure

### Limitations

- Cognee's internal storage is ephemeral (pruned after each extraction)
- No long-term knowledge accumulation within Cognee itself
- Domain detection is keyword-based (not semantic)
- Signal extraction uses simple pattern matching on transcript text

## Related Pages

- [[cognee-integration]]
- [[autopilot-system]]
- [[autopilot-automations]]
- [[autonomous-execution]]

## Sources

- `raw/autonomy/cognee-integration-design.md`

## Last Updated

2026-04-12
