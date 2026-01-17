"""
VTID-01152 + VTID-01185: Mem0 OSS Memory Service with Qdrant Cloud

Memory service for ORB using:
- Anthropic Claude for LLM reasoning (fact extraction)
- Sentence Transformers for local embeddings (all-MiniLM-L6-v2)
- Qdrant Cloud for PERSISTENT vector storage (VTID-01185)
- SQLite for history storage

Storage modes:
- Cloud mode (QDRANT_URL set): Uses Qdrant Cloud for persistent storage
- Local mode (fallback): Uses /tmp/qdrant - EPHEMERAL, data lost on restart

VTID-01185: Migrated from local-only storage to support Qdrant Cloud
for production-grade persistent memory across container restarts.
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
    """
    VTID-01185: Mem0 configuration with Anthropic + Qdrant Cloud.

    Supports two modes:
    - Cloud mode (QDRANT_URL set): Uses Qdrant Cloud for persistent vector storage
    - Local mode (QDRANT_URL not set): Uses local /tmp/qdrant (EPHEMERAL - for dev only)
    """

    # LLM config
    anthropic_api_key: str
    llm_model: str = "claude-sonnet-4-20250514"

    # Embedding config
    embedding_model: str = "all-MiniLM-L6-v2"

    # Qdrant Cloud config (VTID-01185)
    qdrant_url: Optional[str] = None
    qdrant_api_key: Optional[str] = None

    # Local storage paths (fallback for dev)
    qdrant_path: str = "/tmp/qdrant"
    history_db_path: str = "~/.mem0/history.db"

    def is_cloud_mode(self) -> bool:
        """Check if using Qdrant Cloud (persistent) vs local (ephemeral)"""
        return bool(self.qdrant_url)

    def to_mem0_config(self) -> Dict[str, Any]:
        """Convert to Mem0 configuration dict"""
        # Expand user path for history db
        history_path = os.path.expanduser(self.history_db_path)
        Path(history_path).parent.mkdir(parents=True, exist_ok=True)

        # VTID-01185: Build Qdrant config based on mode
        if self.is_cloud_mode():
            # Cloud mode: use URL + API key for persistent storage
            qdrant_config = {
                "url": self.qdrant_url,
                "api_key": self.qdrant_api_key,
                "embedding_model_dims": 384,  # all-MiniLM-L6-v2 dimension
            }
            logger.info(f"VTID-01185: Using Qdrant Cloud at {self.qdrant_url[:50]}...")
        else:
            # Local mode: ephemeral storage (WARNING: lost on container restart)
            qdrant_config = {
                "path": self.qdrant_path,
                "embedding_model_dims": 384,  # all-MiniLM-L6-v2 dimension
            }
            logger.warning(
                "VTID-01185: Using LOCAL Qdrant at %s - EPHEMERAL! "
                "Set QDRANT_URL for persistent storage.",
                self.qdrant_path
            )

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
                "config": qdrant_config,
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


# VTID-DEBUG-MEM: Assistant message patterns to REJECT (prevent hallucination poisoning)
ASSISTANT_REJECT_PATTERNS = [
    # "I don't know" patterns
    r"(?:ich\s+)?wei[ßs]\s+(?:ich\s+)?nicht",
    r"(?:ich\s+)?habe\s+(?:gerade\s+)?nicht\s+parat",
    r"(?:ich\s+)?kenne?\s+(?:ich\s+)?nicht",
    r"(?:ich\s+)?erinnere?\s+mich\s+nicht",
    r"i\s+don'?t\s+(?:know|have|remember)",
    r"i\s+(?:can'?t|cannot)\s+(?:remember|recall)",
    r"i\s+(?:don'?t|do\s+not)\s+have\s+(?:that|this|any)\s+information",
    r"(?:not|no)\s+(?:in\s+)?(?:my\s+)?memory",
    r"keine?\s+(?:information|erinnerung|ahnung)",
    # Meta-commentary about capabilities
    r"(?:ich\s+)?bin\s+(?:nur\s+)?(?:ein\s+)?(?:ki|ai|sprachmodell|assistant)",
    r"i'?m\s+(?:just\s+)?(?:an?\s+)?(?:ai|language\s+model|assistant)",
    r"(?:ich\s+)?kann?\s+(?:das\s+)?nicht\s+(?:tun|machen|speichern)",
    r"i\s+(?:can'?t|cannot)\s+(?:do|store|remember)\s+that",
    # Negative acknowledgments
    r"(?:tut\s+mir\s+)?leid",
    r"(?:i'?m\s+)?sorry",
    r"entschuldigung",
    # Reset/forget patterns (prevent storing these as facts!)
    r"(?:ich\s+)?(?:habe|werde)\s+(?:das\s+)?(?:vergessen|zurückgesetzt)",
    r"(?:my\s+)?memory\s+(?:has\s+been\s+)?(?:reset|cleared|wiped)",
]

ASSISTANT_REJECT_REGEX = [re.compile(p, re.IGNORECASE) for p in ASSISTANT_REJECT_PATTERNS]


def is_assistant_storable(text: str) -> bool:
    """
    VTID-DEBUG-MEM: Check if assistant message should be stored.

    We DO want to store assistant responses that:
    - Acknowledge user facts ("Nice to meet you, Alice!")
    - Confirm information ("Yes, I'll remember that")
    - Reference stored knowledge ("Based on your preference for...")

    We DO NOT want to store:
    - "I don't know" responses (prevents hallucination poisoning)
    - Meta-commentary about AI limitations
    - Error messages or apologies
    """
    text = text.strip()

    # Too short
    if len(text) < 15:
        return False

    # Check reject patterns
    for pattern in ASSISTANT_REJECT_REGEX:
        if pattern.search(text):
            logger.debug(f"Assistant message rejected: matched reject pattern")
            return False

    return True


def should_store_message(text: str, role: str) -> tuple[bool, str]:
    """
    VTID-DEBUG-MEM: Unified message storage decision.

    Returns (should_store, decision_reason)
    """
    # User messages
    if role == "user":
        if is_filler_message(text):
            return False, "rejected_filler"
        clean_text = text.strip()
        if len(clean_text) < 10:
            return False, "rejected_too_short"
        return True, "user_fact"

    # Assistant messages - NEW: we now store these (with filtering)
    if role == "assistant":
        if not is_assistant_storable(text):
            return False, "rejected_assistant_negative"
        return True, "assistant_context"

    return False, "rejected_unknown_role"


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

        # VTID-01185: Read Qdrant Cloud config
        qdrant_url = os.environ.get("QDRANT_URL")
        qdrant_api_key = os.environ.get("QDRANT_API_KEY")

        # Validate: if URL is set, API key is required
        if qdrant_url and not qdrant_api_key:
            logger.warning(
                "VTID-01185: QDRANT_URL is set but QDRANT_API_KEY is missing! "
                "Falling back to local storage."
            )
            qdrant_url = None

        return Mem0Config(
            anthropic_api_key=api_key,
            qdrant_url=qdrant_url,
            qdrant_api_key=qdrant_api_key,
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

        # VTID-01185: Log storage mode clearly
        if config.is_cloud_mode():
            logger.info("VTID-01185: Initializing Mem0 with Qdrant Cloud (PERSISTENT)")
            logger.info(f"  Qdrant URL: {config.qdrant_url[:50]}...")
        else:
            logger.warning("VTID-01185: Initializing Mem0 with LOCAL storage (EPHEMERAL)")
            logger.warning(f"  Qdrant path: {config.qdrant_path}")
            logger.warning("  WARNING: Data will be LOST on container restart!")

        logger.info(f"  LLM: {config.llm_model}")
        logger.info(f"  Embeddings: {config.embedding_model}")

        self._memory = Memory.from_config(mem0_config)
        self._initialized = True
        self._config = config  # Store for health checks
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

        VTID-DEBUG-MEM: Updated to support both user and assistant messages.

        Enforces ORB memory rules:
        - Store user-originated facts
        - Store assistant responses that acknowledge/confirm (NOT "I don't know")
        - Drop filler messages and negative assistant responses
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

        # VTID-DEBUG-MEM: Use unified storage decision (supports both user and assistant)
        should_store, decision = should_store_message(content, role)
        if not should_store:
            result["decision"] = decision
            logger.debug(f"Memory write rejected: {result['decision']} (role={role})")
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

    def health_check(self) -> Dict[str, Any]:
        """
        VTID-01185: Health check for Qdrant connectivity.

        Returns status info for monitoring dashboards.
        """
        result = {
            "ok": False,
            "storage_mode": "unknown",
            "timestamp": time.time(),
        }

        try:
            config = self._get_config()
            result["storage_mode"] = "cloud" if config.is_cloud_mode() else "local"

            if config.is_cloud_mode():
                result["qdrant_url"] = config.qdrant_url[:50] + "..." if config.qdrant_url else None
            else:
                result["qdrant_path"] = config.qdrant_path

            # Try to initialize and do a simple operation
            self._ensure_initialized()

            # Test connectivity by doing a search with a test user
            # This will fail fast if Qdrant is unreachable
            test_result = self._memory.search(
                "health check test",
                user_id="__health_check__",
                limit=1
            )

            result["ok"] = True
            result["collections_accessible"] = True

        except Exception as e:
            logger.error(f"Health check failed: {e}")
            result["ok"] = False
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


def memory_health_check() -> Dict[str, Any]:
    """VTID-01185: Health check for Qdrant connectivity"""
    return get_memory_service().health_check()
