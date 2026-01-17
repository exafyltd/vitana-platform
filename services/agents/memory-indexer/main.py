"""
VTID-01152 + VTID-01185: Mem0 Memory Indexer with Qdrant Cloud

Memory service for ORB using:
- Anthropic Claude for LLM reasoning
- Sentence Transformers for local embeddings
- Qdrant Cloud for PERSISTENT vector storage (VTID-01185)

Endpoints:
- /health - Basic health check
- /health/deep - Deep health check (verifies Qdrant connectivity)
- /introspect - Build info with storage mode
- /memory/write - Write memory item (enforces ORB rules)
- /memory/search - Search memory
- /memory/context - Get context injection for prompts
- /memory/all - Get all memories for user
- /memory/delete - Delete specific memory
- /memory/delete_all - Delete all user memories
- /ingest - Legacy endpoint (deprecated)
"""

import os
import logging
from flask import Flask, jsonify, request

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s"
)
logger = logging.getLogger("memory-indexer")

app = Flask(__name__)


# ============================================================================
# Health & Introspection
# ============================================================================

@app.route("/health")
def health():
    """Basic health check endpoint (does not verify Qdrant)"""
    # VTID-01185: Report storage mode from env
    qdrant_url = os.getenv("QDRANT_URL")
    storage_mode = "cloud" if qdrant_url else "local"

    return jsonify(
        status="ok",
        service="memory-indexer",
        vtid="VTID-01152",
        storage_mode=storage_mode,
    ), 200


@app.route("/health/deep")
def health_deep():
    """
    VTID-01185: Deep health check that verifies Qdrant connectivity.

    Use this for monitoring dashboards to detect Qdrant Cloud outages.
    """
    from mem0_service import memory_health_check

    result = memory_health_check()

    status_code = 200 if result.get("ok") else 503

    return jsonify(
        status="ok" if result.get("ok") else "error",
        service="memory-indexer",
        vtid="VTID-01185",
        **result
    ), status_code


@app.route("/introspect")
def introspect():
    """Build introspection endpoint"""
    # VTID-01185: Report storage mode
    qdrant_url = os.getenv("QDRANT_URL")
    storage_mode = "cloud" if qdrant_url else "local"

    features = [
        "mem0_oss",
        "anthropic_llm",
        "local_embeddings",
        "orb_memory_rules",
    ]

    # Add storage-specific feature
    if storage_mode == "cloud":
        features.append("qdrant_cloud_persistent")
    else:
        features.append("qdrant_local_ephemeral")

    return jsonify(
        build_sha=os.getenv("GITHUB_SHA", "dev"),
        service="memory-indexer",
        vtid="VTID-01152",
        version="1.2.0",  # VTID-01185: Bumped version for Qdrant Cloud support
        storage_mode=storage_mode,
        features=features,
    ), 200


# ============================================================================
# Memory Endpoints
# ============================================================================

@app.route("/memory/write", methods=["POST"])
def memory_write():
    """
    Write memory item for a user.

    Enforces ORB memory rules:
    - Only store user-originated facts
    - Never store assistant messages into identity/relationships
    - Drop filler messages
    - Deduplicate semantically

    Request body:
    {
        "user_id": "string",
        "content": "string",
        "role": "user" | "assistant",
        "metadata": {}  # optional
    }

    Response:
    {
        "user_id": "string",
        "role": "string",
        "decision": "memory_write_decision" | "rejected_*",
        "stored": boolean,
        "memory_ids": [],
        "timestamp": number
    }
    """
    from mem0_service import memory_write as mem0_write

    data = request.get_json() or {}

    user_id = data.get("user_id")
    content = data.get("content")
    role = data.get("role", "user")
    metadata = data.get("metadata")

    if not user_id:
        return jsonify(error="user_id is required"), 400
    if not content:
        return jsonify(error="content is required"), 400

    result = mem0_write(user_id, content, role, metadata)

    logger.info(f"Memory write: user={user_id}, decision={result.get('decision')}")

    return jsonify(result), 200


@app.route("/memory/search", methods=["POST"])
def memory_search():
    """
    Search memory for a user.

    Returns top K facts most relevant to the query.
    No category ordering, no regex ranking.

    Request body:
    {
        "user_id": "string",
        "query": "string",
        "top_k": 5  # optional, default 5
    }

    Response:
    {
        "user_id": "string",
        "query": "string",
        "hits": [
            {"id": "string", "memory": "string", "score": number, "metadata": {}}
        ],
        "decision": "memory_search_hits",
        "timestamp": number
    }
    """
    from mem0_service import memory_search as mem0_search

    data = request.get_json() or {}

    user_id = data.get("user_id")
    query = data.get("query")
    top_k = data.get("top_k", 5)

    if not user_id:
        return jsonify(error="user_id is required"), 400
    if not query:
        return jsonify(error="query is required"), 400

    result = mem0_search(user_id, query, top_k)

    logger.info(f"Memory search: user={user_id}, hits={len(result.get('hits', []))}")

    return jsonify(result), 200


@app.route("/memory/context", methods=["POST"])
def memory_context():
    """
    Get context injection string for LLM prompts.

    Returns formatted string with top K relevant facts.

    Request body:
    {
        "user_id": "string",
        "query": "string",
        "top_k": 5  # optional
    }

    Response:
    {
        "context": "string",
        "user_id": "string"
    }
    """
    from mem0_service import memory_context as mem0_context

    data = request.get_json() or {}

    user_id = data.get("user_id")
    query = data.get("query")
    top_k = data.get("top_k", 5)

    if not user_id:
        return jsonify(error="user_id is required"), 400
    if not query:
        return jsonify(error="query is required"), 400

    context = mem0_context(user_id, query, top_k)

    return jsonify(
        context=context,
        user_id=user_id,
    ), 200


@app.route("/memory/all", methods=["GET"])
def memory_all():
    """
    Get all memories for a user.

    Query params:
    - user_id: string (required)

    Response:
    {
        "user_id": "string",
        "memories": [
            {"id": "string", "memory": "string", "metadata": {}, "created_at": "string"}
        ],
        "timestamp": number
    }
    """
    from mem0_service import get_memory_service

    user_id = request.args.get("user_id")

    if not user_id:
        return jsonify(error="user_id is required"), 400

    result = get_memory_service().get_all(user_id)

    return jsonify(result), 200


@app.route("/memory/delete", methods=["DELETE"])
def memory_delete():
    """
    Delete a specific memory by ID.

    Request body:
    {
        "memory_id": "string"
    }
    """
    from mem0_service import get_memory_service

    data = request.get_json() or {}
    memory_id = data.get("memory_id")

    if not memory_id:
        return jsonify(error="memory_id is required"), 400

    result = get_memory_service().delete(memory_id)

    return jsonify(result), 200


@app.route("/memory/delete_all", methods=["DELETE"])
def memory_delete_all():
    """
    Delete all memories for a user.

    Request body:
    {
        "user_id": "string"
    }
    """
    from mem0_service import get_memory_service

    data = request.get_json() or {}
    user_id = data.get("user_id")

    if not user_id:
        return jsonify(error="user_id is required"), 400

    result = get_memory_service().delete_all(user_id)

    return jsonify(result), 200


# ============================================================================
# Legacy Endpoint (Deprecated)
# ============================================================================

@app.route("/ingest", methods=["POST"])
def ingest():
    """
    Legacy ingest endpoint - DEPRECATED.

    Use /memory/write instead.
    """
    logger.warning("Deprecated /ingest endpoint called - use /memory/write")
    return jsonify(
        status="deprecated",
        message="Use /memory/write instead",
    ), 200


# ============================================================================
# Main
# ============================================================================

if __name__ == "__main__":
    port = int(os.getenv("PORT", 8080))
    debug = os.getenv("FLASK_DEBUG", "false").lower() == "true"

    # VTID-01185: Log storage mode on startup
    qdrant_url = os.getenv("QDRANT_URL")
    storage_mode = "Qdrant Cloud (PERSISTENT)" if qdrant_url else "Local /tmp/qdrant (EPHEMERAL)"

    logger.info(f"Starting memory-indexer on port {port}")
    logger.info(f"VTID-01185: Storage mode: {storage_mode}")
    if qdrant_url:
        logger.info(f"  Qdrant URL: {qdrant_url[:50]}...")
    else:
        logger.warning("  WARNING: Set QDRANT_URL for persistent storage!")

    app.run(host="0.0.0.0", port=port, debug=debug)
