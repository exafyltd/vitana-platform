# Cognee Integration Design for Vitana Platform

**VTID**: VTID-01225
**Status**: Implementation
**Author**: Claude
**Date**: 2026-02-01
**Migration**: `20260201000000_vtid_01225_cognee_extractor.sql`

## Executive Summary

This document defines the architecture for integrating Cognee as a **stateless entity extraction engine** into Vitana's existing memory infrastructure. Cognee will process ORB voice transcripts and output normalized entities/relationships that are then persisted into Vitana's VTID-01087 relationship graph under full ContextLens governance.

## Critical Design Constraints

Based on analysis of Cognee's documented behavior and Vitana's governance requirements:

| Constraint | Rationale |
|------------|-----------|
| **No Cognee EBAC** | Cognee's permission system (ENABLE_BACKEND_ACCESS_CONTROL) forces specific default backends and ignores custom providers. Vitana's ContextLens handles isolation. |
| **Dataset per Tenant** | Dataset-per-user would explode dataset count. Use `dataset_name=tenant_{tenant_id}` with session metadata for user separation. |
| **Default Graph Store** | Use Cognee's default graph store (Kuzu) for POC. Persisted output goes to VTID-01087 tables. |
| **Cognee outputs are advisory** | Vitana writes are governed and auditable. Cognee extractions require validation before persistence. |

## Architecture

```
┌──────────────────────────────────────────────────────────────────────────┐
│                          ORB Live API (orb-live.ts)                       │
│                     Vertex AI Gemini 2.0 Voice Streams                    │
└──────────────────────────────────────────────────────────────────────────┘
                                      │
                              Transcript + ContextLens
                                      │
                                      ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                     COGNEE EXTRACTOR SERVICE (NEW)                        │
│                                                                           │
│   Python Cloud Run Service (Stateless)                                    │
│   ├─ Input: { transcript, tenant_id, user_id, session_id }               │
│   ├─ cognee.add(transcript, dataset_name=f"tenant_{tenant_id}")          │
│   ├─ cognee.cognify()  → Extract entities & relationships                │
│   ├─ Normalize to Vitana schema                                          │
│   └─ Output: { entities[], relationships[], signals[] }                  │
│                                                                           │
│   NO EBAC | NO PERSISTENCE | EXTRACTION ONLY                             │
└──────────────────────────────────────────────────────────────────────────┘
                                      │
                          Normalized Entity JSON
                                      │
                                      ▼
┌──────────────────────────────────────────────────────────────────────────┐
│               VITANA RELATIONSHIP BRIDGE (gateway)                        │
│                                                                           │
│   POST /api/v1/relationships/from-cognee                                 │
│   ├─ Validates ContextLens (tenant_id, user_id, active_role)             │
│   ├─ Calls relationship_ensure_node() RPC                                │
│   ├─ Calls relationship_add_edge() RPC with origin='autopilot'           │
│   └─ Emits OASIS events for monitoring                                   │
│                                                                           │
│   FULL RLS | FULL GOVERNANCE | AUDITABLE                                 │
└──────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                    SUPABASE (VTID-01087 Tables)                           │
│                                                                           │
│   relationship_nodes (tenant_id, node_type, title, domain, metadata)     │
│   relationship_edges (tenant_id, user_id, from_node_id, to_node_id,      │
│                       relationship_type, strength, origin, context)       │
│   relationship_signals (tenant_id, user_id, signal_key, confidence)      │
│                                                                           │
│   RLS ENFORCED | TENANT+USER ISOLATION | AUDITABLE                       │
└──────────────────────────────────────────────────────────────────────────┘
```

## Entity Type Mapping

### Cognee Entity Types → Vitana Node Types

| Cognee Entity | Vitana node_type | Notes |
|---------------|------------------|-------|
| Person | `person` | Names, references to people |
| Organization | `group` | Companies, teams, communities |
| Event | `event` | Meetups, appointments, activities |
| Location | `location` | Places, addresses, regions |
| Product | `product` | Products mentioned |
| Service | `service` | Services discussed |
| Concept | (metadata) | Stored as metadata on related nodes |

### Cognee Relationships → Vitana relationship_type

| Cognee Relationship | Vitana relationship_type | Notes |
|--------------------|-------------------------|-------|
| KNOWS | `friend` | Person-to-person |
| WORKS_FOR | `member` | Person-to-organization |
| ATTENDS | `attendee` | Person-to-event |
| INTERESTED_IN | `interested` | Person-to-anything |
| USES | `using` | Person-to-product/service |
| LOCATED_IN | `visited` | Person-to-location |
| FOLLOWS | `following` | Social connections |

### Domain Detection

| Keywords/Context | Vitana domain |
|-----------------|---------------|
| health, medical, doctor, symptom, therapy | `health` |
| business, work, company, meeting, project | `business` |
| hobby, sport, travel, leisure, fun | `lifestyle` |
| (default) | `community` |

## Implementation

### Phase 1: Cognee Extractor Service

**Location**: `services/agents/cognee-extractor/`

```python
# services/agents/cognee-extractor/main.py

import os
import asyncio
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from typing import List, Optional
import cognee

app = FastAPI(title="Cognee Extractor Service")

# Configuration - NO EBAC, NO CUSTOM PROVIDERS
# Uses Cognee defaults: LanceDB (vector), Kuzu (graph)

class ExtractionRequest(BaseModel):
    transcript: str
    tenant_id: str
    user_id: str
    session_id: str
    active_role: Optional[str] = "community"

class Entity(BaseModel):
    name: str
    entity_type: str  # Cognee's raw type
    vitana_node_type: str  # Mapped Vitana type
    domain: str
    metadata: dict

class Relationship(BaseModel):
    from_entity: str
    to_entity: str
    cognee_type: str  # Cognee's raw type
    vitana_type: str  # Mapped Vitana type
    context: dict

class Signal(BaseModel):
    signal_key: str
    confidence: int  # 0-100
    evidence: dict

class ExtractionResponse(BaseModel):
    ok: bool
    entities: List[Entity]
    relationships: List[Relationship]
    signals: List[Signal]
    session_id: str
    tenant_id: str
    user_id: str

# Type mappings
ENTITY_TYPE_MAP = {
    "Person": "person",
    "Organization": "group",
    "Event": "event",
    "Location": "location",
    "Product": "product",
    "Service": "service",
}

RELATIONSHIP_TYPE_MAP = {
    "KNOWS": "friend",
    "WORKS_FOR": "member",
    "ATTENDS": "attendee",
    "INTERESTED_IN": "interested",
    "USES": "using",
    "LOCATED_IN": "visited",
    "FOLLOWS": "following",
}

DOMAIN_KEYWORDS = {
    "health": ["health", "medical", "doctor", "symptom", "therapy", "wellness", "hospital"],
    "business": ["business", "work", "company", "meeting", "project", "office", "job"],
    "lifestyle": ["hobby", "sport", "travel", "leisure", "fun", "vacation", "game"],
}

def detect_domain(text: str) -> str:
    """Detect domain from text content."""
    text_lower = text.lower()
    for domain, keywords in DOMAIN_KEYWORDS.items():
        if any(kw in text_lower for kw in keywords):
            return domain
    return "community"

def map_entity_type(cognee_type: str) -> str:
    """Map Cognee entity type to Vitana node_type."""
    return ENTITY_TYPE_MAP.get(cognee_type, "person")

def map_relationship_type(cognee_type: str) -> str:
    """Map Cognee relationship type to Vitana relationship_type."""
    return RELATIONSHIP_TYPE_MAP.get(cognee_type, "interested")

@app.post("/extract", response_model=ExtractionResponse)
async def extract_entities(request: ExtractionRequest):
    """
    Extract entities and relationships from transcript using Cognee.

    This is a STATELESS extraction - Cognee's internal storage is ephemeral.
    All persistence happens in Vitana's VTID-01087 tables via the gateway.
    """
    try:
        # Use dataset per tenant (NOT per user - avoids scalability trap)
        dataset_name = f"tenant_{request.tenant_id}"

        # Add transcript to Cognee
        await cognee.add(
            data=request.transcript,
            dataset_name=dataset_name
        )

        # Generate knowledge graph
        await cognee.cognify()

        # Search for entities
        entity_results = await cognee.search(
            query="all entities mentioned",
            search_type="graph"
        )

        # Search for relationships
        relationship_results = await cognee.search(
            query="relationships between entities",
            search_type="graph"
        )

        # Normalize entities
        entities = []
        for e in entity_results.get("nodes", []):
            entity_type = e.get("type", "Person")
            entities.append(Entity(
                name=e.get("name", e.get("label", "Unknown")),
                entity_type=entity_type,
                vitana_node_type=map_entity_type(entity_type),
                domain=detect_domain(request.transcript),
                metadata={
                    "cognee_id": e.get("id"),
                    "source": "cognee",
                    "session_id": request.session_id,
                    "properties": e.get("properties", {})
                }
            ))

        # Normalize relationships
        relationships = []
        for r in relationship_results.get("edges", []):
            rel_type = r.get("type", "RELATED_TO")
            relationships.append(Relationship(
                from_entity=r.get("source", ""),
                to_entity=r.get("target", ""),
                cognee_type=rel_type,
                vitana_type=map_relationship_type(rel_type),
                context={
                    "cognee_id": r.get("id"),
                    "source": "cognee",
                    "session_id": request.session_id,
                    "properties": r.get("properties", {})
                }
            ))

        # Generate signals (behavioral patterns)
        signals = extract_signals(request.transcript, entities, relationships)

        # Reset Cognee dataset to keep service stateless
        # (All persistence happens in Vitana's Supabase)
        await cognee.prune.prune_data(dataset_name)

        return ExtractionResponse(
            ok=True,
            entities=entities,
            relationships=relationships,
            signals=signals,
            session_id=request.session_id,
            tenant_id=request.tenant_id,
            user_id=request.user_id
        )

    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

def extract_signals(transcript: str, entities: List[Entity], relationships: List[Relationship]) -> List[Signal]:
    """
    Extract behavioral signals from transcript and entities.
    These become relationship_signals in VTID-01087.
    """
    signals = []
    text_lower = transcript.lower()

    # Detect social preferences
    if "small group" in text_lower or "few people" in text_lower:
        signals.append(Signal(
            signal_key="prefers_small_groups",
            confidence=70,
            evidence={"source": "transcript", "pattern": "small_group_mention"}
        ))

    if "one on one" in text_lower or "1:1" in text_lower:
        signals.append(Signal(
            signal_key="prefers_individual",
            confidence=80,
            evidence={"source": "transcript", "pattern": "individual_preference"}
        ))

    # Detect activity preferences
    activity_keywords = {
        "walking": "likes_walking",
        "hiking": "likes_hiking",
        "coffee": "likes_coffee_meetups",
        "online": "prefers_online",
        "video call": "prefers_video",
    }

    for keyword, signal_key in activity_keywords.items():
        if keyword in text_lower:
            signals.append(Signal(
                signal_key=signal_key,
                confidence=60,
                evidence={"source": "transcript", "keyword": keyword}
            ))

    # Detect domain interests from entity count
    domain_counts = {}
    for e in entities:
        domain_counts[e.domain] = domain_counts.get(e.domain, 0) + 1

    if domain_counts.get("health", 0) >= 2:
        signals.append(Signal(
            signal_key="health_focused",
            confidence=min(50 + domain_counts["health"] * 10, 90),
            evidence={"source": "entity_analysis", "health_entity_count": domain_counts["health"]}
        ))

    return signals

@app.get("/health")
async def health_check():
    return {"status": "healthy", "service": "cognee-extractor"}
```

### Phase 2: Vitana Gateway Integration

**Location**: `services/gateway/src/routes/relationships.ts` (extend existing)

```typescript
// Add to services/gateway/src/routes/relationships.ts

import { Router } from 'express';
import { createClient } from '@supabase/supabase-js';
import { requireAuth, requireContextLens } from '../middleware/auth';
import { oasis } from '../services/oasis';

interface CogneeEntity {
  name: string;
  entity_type: string;
  vitana_node_type: string;
  domain: string;
  metadata: Record<string, unknown>;
}

interface CogneeRelationship {
  from_entity: string;
  to_entity: string;
  cognee_type: string;
  vitana_type: string;
  context: Record<string, unknown>;
}

interface CogneeSignal {
  signal_key: string;
  confidence: number;
  evidence: Record<string, unknown>;
}

interface CogneeExtractionPayload {
  ok: boolean;
  entities: CogneeEntity[];
  relationships: CogneeRelationship[];
  signals: CogneeSignal[];
  session_id: string;
  tenant_id: string;
  user_id: string;
}

/**
 * POST /api/v1/relationships/from-cognee
 *
 * Receives normalized entity/relationship data from Cognee Extractor Service
 * and persists it to VTID-01087 relationship graph tables under full governance.
 *
 * VTID: VTID-COGNEE-001
 */
router.post('/from-cognee', requireAuth, requireContextLens, async (req, res) => {
  const startTime = Date.now();
  const lens = req.contextLens!;
  const payload = req.body as CogneeExtractionPayload;

  // Validate payload matches request context (security check)
  if (payload.tenant_id !== lens.tenant_id) {
    return res.status(403).json({
      ok: false,
      error: 'TENANT_MISMATCH',
      message: 'Payload tenant_id does not match authenticated context'
    });
  }

  if (payload.user_id !== lens.user_id) {
    return res.status(403).json({
      ok: false,
      error: 'USER_MISMATCH',
      message: 'Payload user_id does not match authenticated context'
    });
  }

  const supabase = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  const results = {
    nodes_created: 0,
    nodes_existing: 0,
    edges_created: 0,
    edges_strengthened: 0,
    signals_created: 0,
    signals_updated: 0,
    errors: [] as string[]
  };

  // Map to track entity name → node ID for relationship creation
  const entityNodeMap = new Map<string, string>();

  try {
    // 1. Create/get nodes for all entities
    for (const entity of payload.entities) {
      const { data: nodeResult, error } = await supabase.rpc('relationship_ensure_node', {
        p_node_type: entity.vitana_node_type,
        p_title: entity.name,
        p_domain: entity.domain,
        p_metadata: {
          ...entity.metadata,
          cognee_type: entity.entity_type,
          origin: 'cognee'
        }
      });

      if (error) {
        results.errors.push(`Node error for ${entity.name}: ${error.message}`);
        continue;
      }

      if (nodeResult.ok) {
        entityNodeMap.set(entity.name, nodeResult.id);
        if (nodeResult.created) {
          results.nodes_created++;
        } else {
          results.nodes_existing++;
        }
      }
    }

    // 2. Create edges for all relationships
    for (const rel of payload.relationships) {
      const fromNodeId = entityNodeMap.get(rel.from_entity);
      const toNodeId = entityNodeMap.get(rel.to_entity);

      if (!fromNodeId || !toNodeId) {
        results.errors.push(`Missing node for relationship: ${rel.from_entity} -> ${rel.to_entity}`);
        continue;
      }

      const { data: edgeResult, error } = await supabase.rpc('relationship_add_edge', {
        p_from_node_id: fromNodeId,
        p_to_node_id: toNodeId,
        p_relationship_type: rel.vitana_type,
        p_origin: 'autopilot',  // Cognee extractions are autopilot-originated
        p_context: {
          ...rel.context,
          cognee_type: rel.cognee_type,
          session_id: payload.session_id
        }
      });

      if (error) {
        results.errors.push(`Edge error: ${error.message}`);
        continue;
      }

      if (edgeResult.ok) {
        if (edgeResult.created) {
          results.edges_created++;
        } else {
          results.edges_strengthened++;
        }
      }
    }

    // 3. Update signals
    for (const signal of payload.signals) {
      const { data: signalResult, error } = await supabase.rpc('relationship_update_signal', {
        p_signal_key: signal.signal_key,
        p_confidence: signal.confidence,
        p_evidence: {
          ...signal.evidence,
          session_id: payload.session_id,
          origin: 'cognee'
        }
      });

      if (error) {
        results.errors.push(`Signal error for ${signal.signal_key}: ${error.message}`);
        continue;
      }

      if (signalResult.ok) {
        if (signalResult.created) {
          results.signals_created++;
        } else {
          results.signals_updated++;
        }
      }
    }

    // Emit OASIS event for monitoring
    oasis.emit('cognee.extraction.persisted', {
      tenant_id: lens.tenant_id,
      user_id: lens.user_id,
      session_id: payload.session_id,
      results,
      duration_ms: Date.now() - startTime
    });

    return res.json({
      ok: true,
      results,
      duration_ms: Date.now() - startTime
    });

  } catch (err) {
    oasis.emit('cognee.extraction.error', {
      tenant_id: lens.tenant_id,
      user_id: lens.user_id,
      session_id: payload.session_id,
      error: err instanceof Error ? err.message : 'Unknown error'
    });

    return res.status(500).json({
      ok: false,
      error: 'PERSISTENCE_ERROR',
      message: err instanceof Error ? err.message : 'Unknown error',
      partial_results: results
    });
  }
});
```

### Phase 3: ORB Live Integration

**Location**: Add to `services/gateway/src/routes/orb-live.ts`

```typescript
// Add to orb-live.ts after transcript is captured

import { cogneeExtractorClient } from '../services/cognee-extractor-client';

/**
 * Fire-and-forget extraction of entities from voice transcript.
 * Called after each complete user turn in the conversation.
 */
async function extractEntitiesFromTranscript(
  transcript: string,
  lens: ContextLens,
  sessionId: string
): Promise<void> {
  // Don't await - fire and forget
  cogneeExtractorClient.extract({
    transcript,
    tenant_id: lens.tenant_id,
    user_id: lens.user_id,
    session_id: sessionId,
    active_role: lens.active_role
  }).then(result => {
    if (result.ok && (result.entities.length > 0 || result.relationships.length > 0)) {
      // Persist to Vitana
      return fetch(`${process.env.GATEWAY_URL}/api/v1/relationships/from-cognee`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${lens.token}`  // Use user's token for RLS
        },
        body: JSON.stringify(result)
      });
    }
  }).catch(err => {
    console.error('[ORB] Cognee extraction failed:', err);
    // Non-blocking - don't fail the conversation
  });
}
```

### Client for Cognee Extractor

**Location**: `services/gateway/src/services/cognee-extractor-client.ts`

```typescript
// services/gateway/src/services/cognee-extractor-client.ts

import { oasis } from './oasis';

interface ExtractionRequest {
  transcript: string;
  tenant_id: string;
  user_id: string;
  session_id: string;
  active_role?: string;
}

interface ExtractionResponse {
  ok: boolean;
  entities: Array<{
    name: string;
    entity_type: string;
    vitana_node_type: string;
    domain: string;
    metadata: Record<string, unknown>;
  }>;
  relationships: Array<{
    from_entity: string;
    to_entity: string;
    cognee_type: string;
    vitana_type: string;
    context: Record<string, unknown>;
  }>;
  signals: Array<{
    signal_key: string;
    confidence: number;
    evidence: Record<string, unknown>;
  }>;
  session_id: string;
  tenant_id: string;
  user_id: string;
}

const COGNEE_EXTRACTOR_URL = process.env.COGNEE_EXTRACTOR_URL || 'http://cognee-extractor:8080';
const TIMEOUT_MS = 30000;  // 30 second timeout for extraction

class CogneeExtractorClient {
  async extract(request: ExtractionRequest): Promise<ExtractionResponse> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      const response = await fetch(`${COGNEE_EXTRACTOR_URL}/extract`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(request),
        signal: controller.signal
      });

      if (!response.ok) {
        throw new Error(`Cognee extractor returned ${response.status}`);
      }

      const result = await response.json() as ExtractionResponse;

      oasis.emit('cognee.extraction.completed', {
        tenant_id: request.tenant_id,
        user_id: request.user_id,
        session_id: request.session_id,
        entity_count: result.entities.length,
        relationship_count: result.relationships.length,
        signal_count: result.signals.length
      });

      return result;

    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        oasis.emit('cognee.extraction.timeout', {
          tenant_id: request.tenant_id,
          session_id: request.session_id
        });
        throw new Error('Cognee extraction timed out');
      }
      throw err;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      const response = await fetch(`${COGNEE_EXTRACTOR_URL}/health`);
      return response.ok;
    } catch {
      return false;
    }
  }
}

export const cogneeExtractorClient = new CogneeExtractorClient();
```

## Deployment

### Cloud Run Configuration

```yaml
# services/agents/cognee-extractor/service.yaml
apiVersion: serving.knative.dev/v1
kind: Service
metadata:
  name: cognee-extractor
  labels:
    vtid: VTID-COGNEE-001
spec:
  template:
    metadata:
      annotations:
        autoscaling.knative.dev/minScale: "0"
        autoscaling.knative.dev/maxScale: "5"
        run.googleapis.com/cpu-throttling: "false"
    spec:
      containerConcurrency: 10
      timeoutSeconds: 60
      containers:
        - image: gcr.io/lovable-vitana-vers1/cognee-extractor:latest
          ports:
            - containerPort: 8080
          resources:
            limits:
              cpu: "2"
              memory: "4Gi"
          env:
            - name: LLM_API_KEY
              valueFrom:
                secretKeyRef:
                  name: cognee-secrets
                  key: llm-api-key
            # NO EBAC ENABLED - Vitana handles governance
            # Default providers: LanceDB (vector), Kuzu (graph)
```

### Dockerfile

```dockerfile
# services/agents/cognee-extractor/Dockerfile
FROM python:3.11-slim

WORKDIR /app

# Install system dependencies
RUN apt-get update && apt-get install -y \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

# Install Python dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application
COPY . .

# Run with uvicorn
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8080"]
```

### Requirements

```txt
# services/agents/cognee-extractor/requirements.txt
cognee>=0.5.1
fastapi>=0.109.0
uvicorn>=0.27.0
pydantic>=2.0.0
```

## Environment Variables

```bash
# Gateway (.env)
COGNEE_EXTRACTOR_URL=https://cognee-extractor-xxxxx-uc.a.run.app

# Cognee Extractor (.env)
# LLM for entity extraction (uses Cognee defaults if not set)
LLM_API_KEY=your-api-key
LLM_PROVIDER=openai  # or vertex_ai
LLM_MODEL=gpt-4o-mini  # or gemini-2.0-flash-exp

# DO NOT SET THESE - uses Cognee defaults
# ENABLE_BACKEND_ACCESS_CONTROL=false  # Explicitly disabled
# VECTOR_DB_PROVIDER=...  # Use default (LanceDB)
# GRAPH_DB_PROVIDER=...   # Use default (Kuzu)
```

## Testing

### Local Test

```bash
# Start Cognee Extractor locally
cd services/agents/cognee-extractor
pip install -r requirements.txt
uvicorn main:app --reload --port 8080

# Test extraction
curl -X POST http://localhost:8080/extract \
  -H "Content-Type: application/json" \
  -d '{
    "transcript": "I had coffee with Maria yesterday. She works at Google and loves hiking in the Alps.",
    "tenant_id": "00000000-0000-0000-0000-000000000001",
    "user_id": "00000000-0000-0000-0000-000000000099",
    "session_id": "test-session-001"
  }'
```

### Expected Output

```json
{
  "ok": true,
  "entities": [
    {
      "name": "Maria",
      "entity_type": "Person",
      "vitana_node_type": "person",
      "domain": "community",
      "metadata": { "cognee_id": "...", "source": "cognee" }
    },
    {
      "name": "Google",
      "entity_type": "Organization",
      "vitana_node_type": "group",
      "domain": "business",
      "metadata": { "cognee_id": "...", "source": "cognee" }
    },
    {
      "name": "Alps",
      "entity_type": "Location",
      "vitana_node_type": "location",
      "domain": "lifestyle",
      "metadata": { "cognee_id": "...", "source": "cognee" }
    }
  ],
  "relationships": [
    {
      "from_entity": "Maria",
      "to_entity": "Google",
      "cognee_type": "WORKS_FOR",
      "vitana_type": "member",
      "context": { "source": "cognee" }
    },
    {
      "from_entity": "Maria",
      "to_entity": "Alps",
      "cognee_type": "INTERESTED_IN",
      "vitana_type": "interested",
      "context": { "source": "cognee" }
    }
  ],
  "signals": [
    {
      "signal_key": "likes_hiking",
      "confidence": 60,
      "evidence": { "source": "transcript", "keyword": "hiking" }
    }
  ],
  "session_id": "test-session-001",
  "tenant_id": "00000000-0000-0000-0000-000000000001",
  "user_id": "00000000-0000-0000-0000-000000000099"
}
```

## Security Considerations

1. **No Cross-Tenant Access**: Cognee uses dataset-per-tenant. Even if Cognee's internal storage leaked, data is still tenant-scoped.

2. **Vitana Writes Are Governed**: All persistence goes through Supabase RPCs with RLS enforcement.

3. **Origin Tracking**: All edges created have `origin='autopilot'` and context includes `"origin": "cognee"` for audit trail.

4. **Stateless Extraction**: Cognee dataset is pruned after extraction. No long-term storage in Cognee.

5. **Token Validation**: Gateway validates ContextLens before accepting Cognee output.

## Monitoring

### OASIS Events

| Event | Description |
|-------|-------------|
| `cognee.extraction.completed` | Extraction finished successfully |
| `cognee.extraction.timeout` | Extraction timed out (30s) |
| `cognee.extraction.persisted` | Results written to Supabase |
| `cognee.extraction.error` | Persistence failed |

## Rollback Plan

1. **Disable Extraction**: Set `COGNEE_EXTRACTOR_URL=""` in gateway env to disable
2. **All existing memory unaffected**: Cognee only adds to relationship graph
3. **Delete Cognee Data**: Query `SELECT * FROM relationship_edges WHERE origin = 'autopilot' AND context->>'origin' = 'cognee'` to identify and optionally remove

## Go / No-Go Checklist

- [ ] Cognee Extractor deployed and healthy
- [ ] Gateway endpoint `/api/v1/relationships/from-cognee` deployed
- [ ] ORB Live integration merged (fire-and-forget call)
- [ ] OASIS events appearing in monitoring
- [ ] Test extraction returns valid Vitana-compatible entities
- [ ] RLS policies verified (cannot cross tenant/user boundaries)
- [ ] Rollback tested (disable env var, verify no side effects)
