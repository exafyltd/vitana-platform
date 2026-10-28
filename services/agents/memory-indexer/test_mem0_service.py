"""
VTID-01152: Verification Tests for Mem0 OSS Local Memory

Test scenarios from requirements:
1. User: "Meine Heimatstadt ist Aachen." -> stored
2. Later: "What's my hometown?" -> Aachen
3. Flood with assistant chatter -> recall still works
4. Logs show: memory_write_decision, memory_search_hits
"""

import os
import sys
import uuid
import time
import pytest
import tempfile
import shutil
from pathlib import Path

# Add parent to path for imports
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))


# ============================================================================
# Unit Tests for ORB Memory Rules (no Mem0 initialization)
# ============================================================================

class TestOrbMemoryRules:
    """Test ORB memory filtering rules"""

    def test_filler_german_dropped(self):
        """German filler messages should be dropped"""
        from mem0_service import is_filler_message

        filler = [
            "ich bin da",
            "ok",
            "ja",
            "nein",
            "hmm",
            "aha",
            "alles klar",
            "verstehe",
            "gut",
            "danke",
            "bitte",
            "genau",
        ]

        for msg in filler:
            assert is_filler_message(msg) is True, f"'{msg}' should be filler"

    def test_filler_english_dropped(self):
        """English filler messages should be dropped"""
        from mem0_service import is_filler_message

        filler = [
            "i'm here",
            "ok",
            "okay",
            "yes",
            "no",
            "hmm",
            "uh huh",
            "i see",
            "sure",
            "got it",
            "thanks",
            "thank you",
            "right",
            "alright",
        ]

        for msg in filler:
            assert is_filler_message(msg) is True, f"'{msg}' should be filler"

    def test_meaningful_content_not_filler(self):
        """Meaningful content should not be marked as filler"""
        from mem0_service import is_filler_message

        meaningful = [
            "Meine Heimatstadt ist Aachen.",
            "My hometown is Aachen.",
            "I prefer dark mode in all my applications.",
            "My birthday is on March 15th.",
            "Ich arbeite als Softwareentwickler.",
        ]

        for msg in meaningful:
            assert is_filler_message(msg) is False, f"'{msg}' should NOT be filler"

    def test_user_role_accepted(self):
        """User messages with meaningful content should be accepted"""
        from mem0_service import is_user_originated_fact

        assert is_user_originated_fact(
            "Meine Heimatstadt ist Aachen.", "user"
        ) is True

    def test_assistant_role_rejected(self):
        """Assistant messages should always be rejected"""
        from mem0_service import is_user_originated_fact

        assert is_user_originated_fact(
            "Meine Heimatstadt ist Aachen.", "assistant"
        ) is False

    def test_short_messages_rejected(self):
        """Very short messages should be rejected"""
        from mem0_service import is_user_originated_fact

        assert is_user_originated_fact("hi", "user") is False
        assert is_user_originated_fact("ok sure", "user") is False

    def test_empty_messages_rejected(self):
        """Empty messages should be rejected"""
        from mem0_service import is_filler_message

        assert is_filler_message("") is True
        assert is_filler_message("   ") is True
        assert is_filler_message("...") is True


# ============================================================================
# Integration Tests (require ANTHROPIC_API_KEY)
# ============================================================================

def requires_anthropic_key():
    """Skip if ANTHROPIC_API_KEY not set"""
    return pytest.mark.skipif(
        not os.environ.get("ANTHROPIC_API_KEY"),
        reason="ANTHROPIC_API_KEY not set"
    )


@requires_anthropic_key()
class TestMem0Integration:
    """Integration tests requiring Anthropic API"""

    @pytest.fixture(autouse=True)
    def setup_temp_storage(self, tmp_path):
        """Set up temporary storage for each test"""
        # Create unique test paths
        self.test_qdrant_path = str(tmp_path / "qdrant")
        self.test_history_path = str(tmp_path / "history.db")

        # Set environment variables
        os.environ["MEM0_QDRANT_PATH"] = self.test_qdrant_path
        os.environ["MEM0_HISTORY_PATH"] = self.test_history_path

        yield

        # Clean up after test
        if os.path.exists(self.test_qdrant_path):
            shutil.rmtree(self.test_qdrant_path)

    def test_scenario_1_hometown_stored(self):
        """
        Verification scenario 1:
        User: "Meine Heimatstadt ist Aachen." -> stored
        """
        from mem0_service import OrbMemoryService

        service = OrbMemoryService()
        user_id = f"test-user-{uuid.uuid4()}"

        result = service.write(
            user_id=user_id,
            content="Meine Heimatstadt ist Aachen.",
            role="user",
        )

        assert result["stored"] is True
        assert result["decision"] == "memory_write_decision"
        assert len(result["memory_ids"]) > 0

        print(f"Scenario 1 PASSED: memory_write_decision logged")

    def test_scenario_2_hometown_recalled(self):
        """
        Verification scenario 2:
        After storing "Meine Heimatstadt ist Aachen."
        Query: "What's my hometown?" -> should find Aachen
        """
        from mem0_service import OrbMemoryService

        service = OrbMemoryService()
        user_id = f"test-user-{uuid.uuid4()}"

        # Store the hometown
        write_result = service.write(
            user_id=user_id,
            content="Meine Heimatstadt ist Aachen.",
            role="user",
        )
        assert write_result["stored"] is True

        # Wait a moment for indexing
        time.sleep(1)

        # Search for hometown
        search_result = service.search(
            user_id=user_id,
            query="What's my hometown?",
            top_k=5,
        )

        assert search_result["decision"] == "memory_search_hits"
        assert len(search_result["hits"]) > 0

        # Check that Aachen is in the results
        memories = [hit.get("memory", "").lower() for hit in search_result["hits"]]
        found_aachen = any("aachen" in mem for mem in memories)

        assert found_aachen, f"Aachen not found in: {memories}"

        print(f"Scenario 2 PASSED: Aachen recalled, memory_search_hits logged")

    def test_scenario_3_assistant_chatter_rejected(self):
        """
        Verification scenario 3:
        Flood with assistant chatter -> should be rejected, recall still works
        """
        from mem0_service import OrbMemoryService

        service = OrbMemoryService()
        user_id = f"test-user-{uuid.uuid4()}"

        # Store user fact
        service.write(
            user_id=user_id,
            content="I live in Berlin and work as a data scientist.",
            role="user",
        )

        # Flood with assistant messages (should all be rejected)
        assistant_chatter = [
            "I understand you live in Berlin!",
            "That's great information.",
            "How can I help you today?",
            "I'll remember that for you.",
            "Is there anything else you'd like to tell me?",
        ]

        rejected_count = 0
        for chatter in assistant_chatter:
            result = service.write(
                user_id=user_id,
                content=chatter,
                role="assistant",
            )
            if result["decision"] == "rejected_assistant_message":
                rejected_count += 1

        assert rejected_count == len(assistant_chatter)

        # Wait for indexing
        time.sleep(1)

        # Recall should still work
        search_result = service.search(
            user_id=user_id,
            query="Where do I live and what's my job?",
            top_k=5,
        )

        assert search_result["decision"] == "memory_search_hits"
        memories = [hit.get("memory", "").lower() for hit in search_result["hits"]]

        found_berlin = any("berlin" in mem for mem in memories)
        assert found_berlin, f"Berlin not found in: {memories}"

        print(f"Scenario 3 PASSED: {rejected_count} assistant messages rejected, recall works")

    def test_scenario_4_context_injection(self):
        """
        Test context injection for LLM prompts
        """
        from mem0_service import OrbMemoryService

        service = OrbMemoryService()
        user_id = f"test-user-{uuid.uuid4()}"

        # Store multiple facts
        facts = [
            "My name is Max Mustermann.",
            "I prefer dark mode in applications.",
            "My favorite programming language is Python.",
        ]

        for fact in facts:
            service.write(user_id=user_id, content=fact, role="user")

        # Wait for indexing
        time.sleep(1)

        # Get context injection
        context = service.build_context_injection(
            user_id=user_id,
            query="What do I like?",
            top_k=5,
        )

        assert "Known facts about the user:" in context
        # Should have at least one bullet point
        assert "- " in context

        print(f"Scenario 4 PASSED: Context injection works")
        print(f"Context:\n{context}")


# ============================================================================
# Flask Endpoint Tests
# ============================================================================

class TestFlaskEndpoints:
    """Test Flask API endpoints"""

    @pytest.fixture
    def client(self):
        """Create test client"""
        from main import app
        app.config["TESTING"] = True
        with app.test_client() as client:
            yield client

    def test_health_endpoint(self, client):
        """Test /health endpoint"""
        response = client.get("/health")
        assert response.status_code == 200
        data = response.get_json()
        assert data["status"] == "ok"
        assert data["vtid"] == "VTID-01152"

    def test_introspect_endpoint(self, client):
        """Test /introspect endpoint"""
        response = client.get("/introspect")
        assert response.status_code == 200
        data = response.get_json()
        assert "mem0_oss" in data["features"]
        assert "anthropic_llm" in data["features"]
        assert data["vtid"] == "VTID-01152"

    def test_memory_write_missing_user_id(self, client):
        """Test /memory/write with missing user_id"""
        response = client.post(
            "/memory/write",
            json={"content": "test"},
        )
        assert response.status_code == 400
        data = response.get_json()
        assert "user_id" in data["error"]

    def test_memory_write_missing_content(self, client):
        """Test /memory/write with missing content"""
        response = client.post(
            "/memory/write",
            json={"user_id": "test-user"},
        )
        assert response.status_code == 400
        data = response.get_json()
        assert "content" in data["error"]

    def test_memory_search_missing_query(self, client):
        """Test /memory/search with missing query"""
        response = client.post(
            "/memory/search",
            json={"user_id": "test-user"},
        )
        assert response.status_code == 400
        data = response.get_json()
        assert "query" in data["error"]

    def test_legacy_ingest_deprecated(self, client):
        """Test /ingest returns deprecation notice"""
        response = client.post("/ingest")
        assert response.status_code == 200
        data = response.get_json()
        assert data["status"] == "deprecated"


# ============================================================================
# Main - Run verification scenarios
# ============================================================================

def run_verification():
    """
    Run verification scenarios manually.

    This can be run directly to test the full flow:
    ANTHROPIC_API_KEY=sk-... python test_mem0_service.py
    """
    print("=" * 60)
    print("VTID-01152: Mem0 OSS Verification")
    print("=" * 60)

    if not os.environ.get("ANTHROPIC_API_KEY"):
        print("ERROR: ANTHROPIC_API_KEY not set")
        print("Run with: ANTHROPIC_API_KEY=sk-... python test_mem0_service.py")
        sys.exit(1)

    # Set up temp storage
    import tempfile
    temp_dir = tempfile.mkdtemp(prefix="mem0_test_")
    os.environ["MEM0_QDRANT_PATH"] = os.path.join(temp_dir, "qdrant")
    os.environ["MEM0_HISTORY_PATH"] = os.path.join(temp_dir, "history.db")

    print(f"\nUsing temp storage: {temp_dir}")

    try:
        from mem0_service import OrbMemoryService

        service = OrbMemoryService()
        user_id = f"verification-user-{uuid.uuid4()}"

        print("\n" + "-" * 60)
        print("Scenario 1: Store hometown")
        print("-" * 60)

        result = service.write(
            user_id=user_id,
            content="Meine Heimatstadt ist Aachen.",
            role="user",
        )

        print(f"  Decision: {result['decision']}")
        print(f"  Stored: {result['stored']}")
        print(f"  Memory IDs: {result['memory_ids']}")

        assert result["decision"] == "memory_write_decision"
        print("  -> PASSED")

        print("\n" + "-" * 60)
        print("Scenario 2: Recall hometown")
        print("-" * 60)

        # Wait for indexing
        time.sleep(2)

        result = service.search(
            user_id=user_id,
            query="What's my hometown?",
            top_k=5,
        )

        print(f"  Decision: {result['decision']}")
        print(f"  Hits: {len(result['hits'])}")

        for hit in result["hits"]:
            print(f"    - {hit.get('memory')} (score: {hit.get('score', 'N/A')})")

        memories = [h.get("memory", "").lower() for h in result["hits"]]
        assert any("aachen" in m for m in memories)
        print("  -> PASSED (Aachen found)")

        print("\n" + "-" * 60)
        print("Scenario 3: Flood with assistant chatter")
        print("-" * 60)

        chatter = [
            "I see you're from Aachen!",
            "That's a lovely city.",
            "How can I help you today?",
        ]

        for msg in chatter:
            result = service.write(
                user_id=user_id,
                content=msg,
                role="assistant",
            )
            print(f"  Assistant: '{msg[:30]}...' -> {result['decision']}")

        # Verify recall still works
        result = service.search(
            user_id=user_id,
            query="What's my hometown?",
            top_k=5,
        )

        memories = [h.get("memory", "").lower() for h in result["hits"]]
        assert any("aachen" in m for m in memories)
        print("  -> PASSED (recall still works)")

        print("\n" + "=" * 60)
        print("ALL VERIFICATION SCENARIOS PASSED")
        print("=" * 60)

    finally:
        # Cleanup
        import shutil
        if os.path.exists(temp_dir):
            shutil.rmtree(temp_dir)
            print(f"\nCleaned up: {temp_dir}")


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--verify":
        run_verification()
    else:
        pytest.main([__file__, "-v"])
