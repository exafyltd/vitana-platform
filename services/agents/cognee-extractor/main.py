"""
VTID-01225: Cognee Entity Extraction Service

Stateless entity extraction engine for ORB voice transcripts.
Outputs normalized entities/relationships for persistence in VTID-01087 tables.

Key Constraints:
- NO Cognee EBAC: Vitana's ContextLens handles governance
- Dataset per tenant (not per user): Avoids scalability trap
- Stateless extraction: Cognee data pruned after each request
- Advisory outputs: Vitana gateway validates and persists

Design Doc: docs/architecture/cognee-integration-design.md
"""

import os
import asyncio
import hashlib
import logging
from contextlib import asynccontextmanager
from typing import List, Optional, Dict, Any

from fastapi import FastAPI, HTTPException, BackgroundTasks
from pydantic import BaseModel, Field
import cognee

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='[%(asctime)s] %(levelname)s %(name)s: %(message)s'
)
logger = logging.getLogger('cognee-extractor')

# =============================================================================
# Configuration
# =============================================================================

# LLM Configuration (uses Cognee defaults if not set)
LLM_API_KEY = os.getenv('LLM_API_KEY')
LLM_PROVIDER = os.getenv('LLM_PROVIDER', 'openai')
LLM_MODEL = os.getenv('LLM_MODEL', 'gpt-4o-mini')

# Service Configuration
SERVICE_NAME = 'cognee-extractor'
VTID = 'VTID-01225'

# =============================================================================
# Type Mappings (Cognee -> Vitana)
# =============================================================================

ENTITY_TYPE_MAP = {
    'Person': 'person',
    'Human': 'person',
    'Individual': 'person',
    'Organization': 'group',
    'Company': 'group',
    'Team': 'group',
    'Group': 'group',
    'Event': 'event',
    'Meeting': 'event',
    'Appointment': 'event',
    'Activity': 'event',
    'Location': 'location',
    'Place': 'location',
    'Address': 'location',
    'City': 'location',
    'Country': 'location',
    'Product': 'product',
    'Item': 'product',
    'Service': 'service',
    'LiveRoom': 'live_room',
}

RELATIONSHIP_TYPE_MAP = {
    'KNOWS': 'friend',
    'FRIENDS_WITH': 'friend',
    'RELATED_TO': 'friend',
    'WORKS_FOR': 'member',
    'MEMBER_OF': 'member',
    'BELONGS_TO': 'member',
    'PART_OF': 'member',
    'ATTENDS': 'attendee',
    'PARTICIPATED_IN': 'attendee',
    'JOINED': 'attendee',
    'INTERESTED_IN': 'interested',
    'LIKES': 'interested',
    'WANTS': 'interested',
    'PREFERS': 'interested',
    'USES': 'using',
    'UTILIZED': 'using',
    'EMPLOYS': 'using',
    'LOCATED_IN': 'visited',
    'LIVES_IN': 'visited',
    'VISITED': 'visited',
    'TRAVELED_TO': 'visited',
    'FOLLOWS': 'following',
    'SUBSCRIBES_TO': 'following',
}

DOMAIN_KEYWORDS = {
    'health': [
        'health', 'medical', 'doctor', 'symptom', 'therapy', 'wellness',
        'hospital', 'medicine', 'treatment', 'diagnosis', 'patient',
        'nurse', 'clinic', 'healthcare', 'disease', 'condition'
    ],
    'business': [
        'business', 'work', 'company', 'meeting', 'project', 'office',
        'job', 'career', 'professional', 'client', 'customer', 'sales',
        'marketing', 'finance', 'revenue', 'startup', 'enterprise'
    ],
    'lifestyle': [
        'hobby', 'sport', 'travel', 'leisure', 'fun', 'vacation', 'game',
        'music', 'art', 'movie', 'book', 'restaurant', 'food', 'cooking',
        'fitness', 'yoga', 'meditation', 'hiking', 'adventure'
    ],
}

# =============================================================================
# Request/Response Models
# =============================================================================

class ExtractionRequest(BaseModel):
    """Request to extract entities from transcript."""
    transcript: str = Field(..., min_length=1, max_length=50000)
    tenant_id: str = Field(..., pattern=r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
    user_id: str = Field(..., pattern=r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
    session_id: str = Field(..., min_length=1, max_length=255)
    active_role: Optional[str] = Field(default='community')


class Entity(BaseModel):
    """Normalized entity for Vitana."""
    name: str
    entity_type: str  # Cognee's raw type
    vitana_node_type: str  # Mapped Vitana type
    domain: str
    metadata: Dict[str, Any]


class Relationship(BaseModel):
    """Normalized relationship for Vitana."""
    from_entity: str
    to_entity: str
    cognee_type: str  # Cognee's raw type
    vitana_type: str  # Mapped Vitana type
    context: Dict[str, Any]


class Signal(BaseModel):
    """Behavioral signal for matchmaking."""
    signal_key: str
    confidence: int = Field(..., ge=0, le=100)
    evidence: Dict[str, Any]


class ExtractionResponse(BaseModel):
    """Response with extracted entities and relationships."""
    ok: bool
    entities: List[Entity]
    relationships: List[Relationship]
    signals: List[Signal]
    session_id: str
    tenant_id: str
    user_id: str
    transcript_hash: str
    processing_ms: int


class HealthResponse(BaseModel):
    """Health check response."""
    status: str
    service: str
    vtid: str
    version: str = '1.0.0'


# =============================================================================
# Helper Functions
# =============================================================================

def detect_domain(text: str) -> str:
    """Detect domain from text content."""
    text_lower = text.lower()
    domain_scores = {domain: 0 for domain in DOMAIN_KEYWORDS}

    for domain, keywords in DOMAIN_KEYWORDS.items():
        for keyword in keywords:
            if keyword in text_lower:
                domain_scores[domain] += 1

    # Return domain with highest score, default to 'community'
    max_domain = max(domain_scores, key=domain_scores.get)
    return max_domain if domain_scores[max_domain] > 0 else 'community'


def map_entity_type(cognee_type: str) -> str:
    """Map Cognee entity type to Vitana node_type."""
    return ENTITY_TYPE_MAP.get(cognee_type, 'person')


def map_relationship_type(cognee_type: str) -> str:
    """Map Cognee relationship type to Vitana relationship_type."""
    # Handle uppercase and variations
    normalized = cognee_type.upper().replace(' ', '_').replace('-', '_')
    return RELATIONSHIP_TYPE_MAP.get(normalized, 'interested')


def compute_transcript_hash(transcript: str) -> str:
    """Compute SHA256 hash of transcript for deduplication."""
    return hashlib.sha256(transcript.encode('utf-8')).hexdigest()[:32]


def extract_signals(
    transcript: str,
    entities: List[Entity],
    relationships: List[Relationship]
) -> List[Signal]:
    """
    Extract behavioral signals from transcript and entities.
    These become relationship_signals in VTID-01087.
    """
    signals = []
    text_lower = transcript.lower()

    # Social preference signals
    social_patterns = {
        'prefers_small_groups': ['small group', 'few people', 'intimate gathering', 'close friends'],
        'prefers_individual': ['one on one', '1:1', 'just us', 'private meeting', 'alone'],
        'prefers_large_groups': ['big group', 'many people', 'crowd', 'party', 'everyone'],
        'prefers_online': ['online', 'virtual', 'remote', 'video call', 'zoom', 'teams'],
        'prefers_in_person': ['in person', 'face to face', 'meet up', 'get together'],
    }

    for signal_key, patterns in social_patterns.items():
        for pattern in patterns:
            if pattern in text_lower:
                signals.append(Signal(
                    signal_key=signal_key,
                    confidence=70,
                    evidence={'source': 'transcript', 'pattern': pattern}
                ))
                break  # One signal per category

    # Activity preference signals
    activity_patterns = {
        'likes_walking': ['walking', 'walk', 'stroll'],
        'likes_hiking': ['hiking', 'hike', 'trail', 'mountain'],
        'likes_coffee_meetups': ['coffee', 'cafe', 'latte', 'espresso'],
        'likes_food_meetups': ['dinner', 'lunch', 'restaurant', 'eat'],
        'likes_sports': ['sport', 'gym', 'workout', 'exercise', 'fitness'],
        'likes_arts': ['art', 'museum', 'gallery', 'theater', 'music'],
        'likes_reading': ['book', 'reading', 'library', 'novel'],
    }

    for signal_key, patterns in activity_patterns.items():
        for pattern in patterns:
            if pattern in text_lower:
                signals.append(Signal(
                    signal_key=signal_key,
                    confidence=60,
                    evidence={'source': 'transcript', 'keyword': pattern}
                ))
                break

    # Domain interest signals from entity analysis
    domain_counts: Dict[str, int] = {}
    for entity in entities:
        domain_counts[entity.domain] = domain_counts.get(entity.domain, 0) + 1

    domain_signals = {
        'health': 'health_focused',
        'business': 'business_focused',
        'lifestyle': 'lifestyle_focused',
    }

    for domain, signal_key in domain_signals.items():
        count = domain_counts.get(domain, 0)
        if count >= 2:
            signals.append(Signal(
                signal_key=signal_key,
                confidence=min(50 + count * 10, 90),
                evidence={
                    'source': 'entity_analysis',
                    f'{domain}_entity_count': count
                }
            ))

    # Relationship density signal
    if len(relationships) >= 3:
        signals.append(Signal(
            signal_key='high_social_connectivity',
            confidence=min(50 + len(relationships) * 5, 85),
            evidence={
                'source': 'relationship_analysis',
                'relationship_count': len(relationships)
            }
        ))

    return signals


# =============================================================================
# Cognee Processing
# =============================================================================

async def process_with_cognee(
    transcript: str,
    tenant_id: str,
    session_id: str
) -> tuple[List[Dict], List[Dict]]:
    """
    Process transcript with Cognee to extract entities and relationships.

    Uses dataset-per-tenant pattern (NOT per-user) per design constraints.
    Dataset is pruned after extraction to maintain statelessness.
    """
    dataset_name = f'tenant_{tenant_id}'

    try:
        # Add transcript to Cognee
        await cognee.add(
            data=transcript,
            dataset_name=dataset_name
        )

        # Generate knowledge graph
        await cognee.cognify()

        # Search for entities and relationships
        # Note: Cognee's search API may vary by version
        try:
            search_results = await cognee.search(
                query='all entities and relationships',
                search_type='insights'
            )
        except Exception:
            # Fallback to graph search if insights not available
            search_results = await cognee.search(
                query='entities',
                search_type='graph'
            )

        # Extract nodes and edges from results
        nodes = []
        edges = []

        if isinstance(search_results, dict):
            nodes = search_results.get('nodes', [])
            edges = search_results.get('edges', [])
        elif isinstance(search_results, list):
            # Handle list-based results
            for item in search_results:
                if isinstance(item, dict):
                    if 'source' in item and 'target' in item:
                        edges.append(item)
                    elif 'name' in item or 'label' in item:
                        nodes.append(item)

        return nodes, edges

    finally:
        # Prune dataset to maintain statelessness
        # All persistence happens in Vitana's Supabase
        try:
            await cognee.prune.prune_data(dataset_name)
        except Exception as e:
            logger.warning(f'Failed to prune dataset {dataset_name}: {e}')


# =============================================================================
# FastAPI Application
# =============================================================================

@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifespan handler."""
    logger.info(f'[{VTID}] Starting {SERVICE_NAME}...')

    # Configure Cognee LLM if API key provided
    if LLM_API_KEY:
        try:
            cognee.config.set_llm_config({
                'provider': LLM_PROVIDER,
                'model': LLM_MODEL,
                'api_key': LLM_API_KEY
            })
            logger.info(f'[{VTID}] Configured Cognee with {LLM_PROVIDER}/{LLM_MODEL}')
        except Exception as e:
            logger.warning(f'[{VTID}] Failed to configure Cognee LLM: {e}')

    logger.info(f'[{VTID}] {SERVICE_NAME} ready')
    yield
    logger.info(f'[{VTID}] Shutting down {SERVICE_NAME}')


app = FastAPI(
    title='Cognee Entity Extraction Service',
    description='VTID-01225: Stateless entity extraction for ORB voice transcripts',
    version='1.0.0',
    lifespan=lifespan
)


@app.get('/health', response_model=HealthResponse)
async def health_check():
    """Health check endpoint for Cloud Run."""
    return HealthResponse(
        status='healthy',
        service=SERVICE_NAME,
        vtid=VTID
    )


@app.post('/extract', response_model=ExtractionResponse)
async def extract_entities(request: ExtractionRequest):
    """
    Extract entities and relationships from transcript using Cognee.

    This is a STATELESS extraction - Cognee's internal storage is ephemeral.
    All persistence happens in Vitana's VTID-01087 tables via the gateway.
    """
    import time
    start_time = time.time()

    logger.info(
        f'[{VTID}] Extraction request: tenant={request.tenant_id[:8]}... '
        f'user={request.user_id[:8]}... session={request.session_id}'
    )

    transcript_hash = compute_transcript_hash(request.transcript)

    try:
        # Process with Cognee
        raw_nodes, raw_edges = await process_with_cognee(
            transcript=request.transcript,
            tenant_id=request.tenant_id,
            session_id=request.session_id
        )

        # Detect overall domain
        overall_domain = detect_domain(request.transcript)

        # Normalize entities
        entities: List[Entity] = []
        entity_names_seen = set()

        for node in raw_nodes:
            name = node.get('name') or node.get('label') or node.get('title', 'Unknown')
            if name in entity_names_seen:
                continue
            entity_names_seen.add(name)

            entity_type = node.get('type') or node.get('entity_type', 'Person')
            vitana_type = map_entity_type(entity_type)

            entities.append(Entity(
                name=name,
                entity_type=entity_type,
                vitana_node_type=vitana_type,
                domain=overall_domain,
                metadata={
                    'cognee_id': node.get('id'),
                    'source': 'cognee',
                    'session_id': request.session_id,
                    'vtid': VTID,
                    'properties': node.get('properties', {})
                }
            ))

        # Normalize relationships
        relationships: List[Relationship] = []

        for edge in raw_edges:
            from_entity = edge.get('source') or edge.get('from', '')
            to_entity = edge.get('target') or edge.get('to', '')
            rel_type = edge.get('type') or edge.get('relationship', 'RELATED_TO')

            if not from_entity or not to_entity:
                continue

            relationships.append(Relationship(
                from_entity=from_entity,
                to_entity=to_entity,
                cognee_type=rel_type,
                vitana_type=map_relationship_type(rel_type),
                context={
                    'cognee_id': edge.get('id'),
                    'source': 'cognee',
                    'session_id': request.session_id,
                    'vtid': VTID,
                    'properties': edge.get('properties', {})
                }
            ))

        # Extract behavioral signals
        signals = extract_signals(request.transcript, entities, relationships)

        processing_ms = int((time.time() - start_time) * 1000)

        logger.info(
            f'[{VTID}] Extraction complete: {len(entities)} entities, '
            f'{len(relationships)} relationships, {len(signals)} signals '
            f'in {processing_ms}ms'
        )

        return ExtractionResponse(
            ok=True,
            entities=entities,
            relationships=relationships,
            signals=signals,
            session_id=request.session_id,
            tenant_id=request.tenant_id,
            user_id=request.user_id,
            transcript_hash=transcript_hash,
            processing_ms=processing_ms
        )

    except Exception as e:
        logger.error(f'[{VTID}] Extraction failed: {e}', exc_info=True)
        raise HTTPException(
            status_code=500,
            detail=f'Extraction failed: {str(e)}'
        )


@app.get('/metrics')
async def get_metrics():
    """Prometheus-compatible metrics endpoint."""
    # Basic metrics for Cloud Run monitoring
    return {
        'service': SERVICE_NAME,
        'vtid': VTID,
        'status': 'ok'
    }


# =============================================================================
# Main Entry Point
# =============================================================================

if __name__ == '__main__':
    import uvicorn
    uvicorn.run(
        'main:app',
        host='0.0.0.0',
        port=int(os.getenv('PORT', 8080)),
        reload=os.getenv('ENV', 'production') == 'development'
    )
