"""
VTID-01152: Mem0 OSS Local Memory Service (Anthropic version)

Local-first fact memory for ORB using:
- Anthropic Claude for LLM reasoning
- Sentence Transformers for local embeddings
- Qdrant for local vector storage
- SQLite for history storage

No Mem0 SaaS. No external services. Fully local persistence.
"""

import os
import re
import time
import uuid
import logging
from pathlib import Path
from typing import Optional, Dict, Any, List
from dataclasses import dataclass

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("mem0_service")

# ============================================================================
# Configuration
# ============================================================================

@dataclass
class Mem0Config:
    """Mem0 configuration with Anthropic + local storage"""

    # LLM config
    anthropic_api_key: str
    llm_model: str = "claude-sonnet-4-20250514"

    # Embedding config
    embedding_model: str = "all-MiniLM-L6-v2"

    # Storage paths
    qdrant_path: str = "/tmp/qdrant"
    history_db_path: str = "~/.mem0/history.db"

    def to_mem0_config(self) -> Dict[str, Any]:
        """Convert to Mem0 configuration dict"""
        # Expand user path for history db
        history_path = os.path.expanduser(self.history_db_path)
        Path(history_path).parent.mkdir(parents=True, exist_ok=True)

        return {
            "llm": {
                "provider": "anthropic",
                "config": {
                    "model": self.llm_model,
                    "api_key": self.anthropic_api_key,
                },
            },
            "embedder": {
                "provider": "huggingface",
                "config": {
                    "model": self.embedding_model,
                },
            },
            "vector_store": {
                "provider": "qdrant",
                "config": {
                    "path": self.qdrant_path,
                },
            },
            "history_store": {
                "provider": "sqlite",
                "config": {
                    "path": history_path,
                },
            },
        }


# ============================================================================
# ORB Memory Rules - Critical Filtering
# ============================================================================

# Filler patterns to drop (German + English)
FILLER_PATTERNS = [
    # German filler
    r"^ich bin da\.?$",
    r"^ok\.?$",
    r"^okay\.?$",
    r"^ja\.?$",
    r"^nein\.?$",
    r"^hm+\.?$",
    r"^aha\.?$",
    r"^alles klar\.?$",
    r"^verstehe\.?$",
    r"^gut\.?$",
    r"^danke\.?$",
    r"^bitte\.?$",
    r"^genau\.?$",
    # English filler
    r"^i'm here\.?$",
    r"^ok\.?$",
    r"^okay\.?$",
    r"^yes\.?$",
    r"^no\.?$",
    r"^hmm+\.?$",
    r"^uh huh\.?$",
    r"^i see\.?$",
    r"^sure\.?$",
    r"^got it\.?$",
    r"^thanks\.?$",
    r"^thank you\.?$",
    r"^right\.?$",
    r"^alright\.?$",
    # Very short/empty
    r"^\.+$",
    r"^\s*$",
]

# Compile patterns for efficiency
FILLER_REGEX = [re.compile(p, re.IGNORECASE) for p in FILLER_PATTERNS]


def is_filler_message(text: str) -> bool:
    """Check if message is filler that should not be stored"""
    text = text.strip()

    # Too short (less than 3 chars)
    if len(text) < 3:
        return True

    # Match filler patterns
    for pattern in FILLER_REGEX:
        if pattern.match(text):
            return True

    return False


def is_user_originated_fact(text: str, role: str) -> bool:
    """
    Check if message contains user-originated facts worth storing.

    ORB Memory Rules:
    - ONLY store user-originated facts
    - NEVER store assistant messages into identity/relationships
    - DROP filler messages
    """
    # Only user messages can contain user facts
    if role != "user":
        return False

    # Drop filler
    if is_filler_message(text):
        return False

    # Must have meaningful content (at least 10 chars after stripping)
    clean_text = text.strip()
    if len(clean_text) < 10:
        return False

    return True


# ============================================================================
# Memory Service
# ============================================================================

class OrbMemoryService:
    """
    Local-first memory service for ORB using Mem0 OSS.

    Uses Anthropic Claude for intelligent fact extraction and
    fully local storage (Qdrant + SQLite).
    """

    def __init__(self, config: Optional[Mem0Config] = None):
        """Initialize memory service with configuration"""
        self._memory = None
        self._config = config
        self._initialized = False

    def _get_config(self) -> Mem0Config:
        """Get or create configuration"""
        if self._config:
            return self._config

        api_key = os.environ.get("ANTHROPIC_API_KEY")
        if not api_key:
            raise ValueError("ANTHROPIC_API_KEY environment variable required")

        return Mem0Config(
            anthropic_api_key=api_key,
            qdrant_path=os.environ.get("MEM0_QDRANT_PATH", "/tmp/qdrant"),
            history_db_path=os.environ.get("MEM0_HISTORY_PATH", "~/.mem0/history.db"),
        )

    def _ensure_initialized(self) -> None:
        """Lazy initialization of Mem0"""
        if self._initialized:
            return

        try:
            from mem0 import Memory
        except ImportError:
            raise ImportError(
                "mem0ai package not installed. Run: pip install mem0ai"
            )

        config = self._get_config()
        mem0_config = config.to_mem0_config()

        logger.info("Initializing Mem0 with Anthropic + local storage")
        logger.info(f"  LLM: {config.llm_model}")
        logger.info(f"  Embeddings: {config.embedding_model}")
        logger.info(f"  Qdrant path: {config.qdrant_path}")

        self._memory = Memory.from_config(mem0_config)
        self._initialized = True
        logger.info("Mem0 initialized successfully")

    def write(
        self,
        user_id: str,
        content: str,
        role: str = "user",
        metadata: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """
        Write memory item for a user.

        Enforces ORB memory rules:
        - Only store user-originated facts
        - Never store assistant messages into identity/relationships
        - Drop filler messages
        - Deduplicate semantically (handled by Mem0)

        Returns decision info for logging/debugging.
        """
        result = {
            "user_id": user_id,
            "role": role,
            "decision": None,
            "stored": False,
            "memory_ids": [],
            "timestamp": time.time(),
        }

        # Apply ORB memory rules
        if not is_user_originated_fact(content, role):
            if role != "user":
                result["decision"] = "rejected_assistant_message"
            elif is_filler_message(content):
                result["decision"] = "rejected_filler"
            else:
                result["decision"] = "rejected_too_short"

            logger.debug(f"Memory write rejected: {result['decision']}")
            return result

        # Initialize Mem0 if needed
        self._ensure_initialized()

        # Build message for Mem0
        messages = [{"role": role, "content": content}]

        # Add metadata if provided
        add_kwargs = {"user_id": user_id}
        if metadata:
            add_kwargs["metadata"] = metadata

        # Store via Mem0 (handles semantic deduplication internally)
        try:
            mem0_result = self._memory.add(messages, **add_kwargs)

            # Extract memory IDs from result
            if isinstance(mem0_result, dict) and "results" in mem0_result:
                result["memory_ids"] = [
                    r.get("id") for r in mem0_result["results"]
                    if r.get("id")
                ]
            elif isinstance(mem0_result, list):
                result["memory_ids"] = [
                    r.get("id") for r in mem0_result
                    if isinstance(r, dict) and r.get("id")
                ]

            result["stored"] = True
            result["decision"] = "memory_write_decision"

            logger.info(f"Memory stored for user {user_id}: {len(result['memory_ids'])} items")

        except Exception as e:
            logger.error(f"Memory write error: {e}")
            result["decision"] = "error"
            result["error"] = str(e)

        return result

    def search(
        self,
        user_id: str,
        query: str,
        top_k: int = 5,
    ) -> Dict[str, Any]:
        """
        Search memory for a user.

        Returns top K facts most relevant to the query.
        No category ordering, no regex ranking - just semantic search.
        """
        result = {
            "user_id": user_id,
            "query": query,
            "hits": [],
            "decision": "memory_search_hits",
            "timestamp": time.time(),
        }

        # Initialize Mem0 if needed
        self._ensure_initialized()

        try:
            mem0_results = self._memory.search(query, user_id=user_id, limit=top_k)

            # Extract hits
            if isinstance(mem0_results, dict) and "results" in mem0_results:
                hits = mem0_results["results"]
            elif isinstance(mem0_results, list):
                hits = mem0_results
            else:
                hits = []

            result["hits"] = [
                {
                    "id": h.get("id"),
                    "memory": h.get("memory"),
                    "score": h.get("score"),
                    "metadata": h.get("metadata", {}),
                }
                for h in hits
                if isinstance(h, dict)
            ]

            logger.info(f"Memory search for user {user_id}: {len(result['hits'])} hits")

        except Exception as e:
            logger.error(f"Memory search error: {e}")
            result["decision"] = "error"
            result["error"] = str(e)

        return result

    def get_all(self, user_id: str) -> Dict[str, Any]:
        """Get all memories for a user"""
        result = {
            "user_id": user_id,
            "memories": [],
            "timestamp": time.time(),
        }

        self._ensure_initialized()

        try:
            mem0_results = self._memory.get_all(user_id=user_id)

            if isinstance(mem0_results, dict) and "results" in mem0_results:
                memories = mem0_results["results"]
            elif isinstance(mem0_results, list):
                memories = mem0_results
            else:
                memories = []

            result["memories"] = [
                {
                    "id": m.get("id"),
                    "memory": m.get("memory"),
                    "metadata": m.get("metadata", {}),
                    "created_at": m.get("created_at"),
                }
                for m in memories
                if isinstance(m, dict)
            ]

        except Exception as e:
            logger.error(f"Memory get_all error: {e}")
            result["error"] = str(e)

        return result

    def delete(self, memory_id: str) -> Dict[str, Any]:
        """Delete a specific memory by ID"""
        result = {
            "memory_id": memory_id,
            "deleted": False,
            "timestamp": time.time(),
        }

        self._ensure_initialized()

        try:
            self._memory.delete(memory_id)
            result["deleted"] = True
        except Exception as e:
            logger.error(f"Memory delete error: {e}")
            result["error"] = str(e)

        return result

    def delete_all(self, user_id: str) -> Dict[str, Any]:
        """Delete all memories for a user"""
        result = {
            "user_id": user_id,
            "deleted": False,
            "timestamp": time.time(),
        }

        self._ensure_initialized()

        try:
            self._memory.delete_all(user_id=user_id)
            result["deleted"] = True
        except Exception as e:
            logger.error(f"Memory delete_all error: {e}")
            result["error"] = str(e)

        return result

    def build_context_injection(
        self,
        user_id: str,
        query: str,
        top_k: int = 5,
    ) -> str:
        """
        Build context injection string for LLM prompts.

        Returns formatted string with top K relevant facts to inject
        into system/user prompts.
        """
        search_result = self.search(user_id, query, top_k)

        if not search_result.get("hits"):
            return ""

        facts = []
        for hit in search_result["hits"]:
            memory = hit.get("memory", "")
            if memory:
                facts.append(f"- {memory}")

        if not facts:
            return ""

        return f"Known facts about the user:\n" + "\n".join(facts)


# ============================================================================
# Singleton instance
# ============================================================================

_service_instance: Optional[OrbMemoryService] = None


def get_memory_service() -> OrbMemoryService:
    """Get singleton memory service instance"""
    global _service_instance
    if _service_instance is None:
        _service_instance = OrbMemoryService()
    return _service_instance


# ============================================================================
# Convenience functions
# ============================================================================

def memory_write(
    user_id: str,
    content: str,
    role: str = "user",
    metadata: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Write memory item for a user"""
    return get_memory_service().write(user_id, content, role, metadata)


def memory_search(
    user_id: str,
    query: str,
    top_k: int = 5,
) -> Dict[str, Any]:
    """Search memory for a user"""
    return get_memory_service().search(user_id, query, top_k)


def memory_context(
    user_id: str,
    query: str,
    top_k: int = 5,
) -> str:
    """Get context injection string for prompts"""
    return get_memory_service().build_context_injection(user_id, query, top_k)
