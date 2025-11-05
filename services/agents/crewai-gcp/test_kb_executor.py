"""
Tests for KB Executor

VTID: DEV-AICOR-0025
"""

import pytest
import asyncio
import tempfile
import os
from pathlib import Path
from unittest.mock import patch, Mock, AsyncMock
from kb_executor import (
    KBExecutor,
    KBAccessError,
    DocumentNotFoundError,
    InvalidPathError
)

@pytest.fixture
def temp_kb_dir():
    """Create temporary KB directory with test documents"""
    with tempfile.TemporaryDirectory() as tmpdir:
        kb_path = Path(tmpdir)
        
        # Create test documents
        (kb_path / "01-TEST-DOC.md").write_text("# Test Document\n\nThis is a test.")
        (kb_path / "02-DEPLOYMENT.md").write_text("# Deployment Guide\n\nDeploy here.")
        (kb_path / "03-CICD.md").write_text("# CI/CD Guide\n\nContinuous integration.")
        
        yield kb_path

@pytest.fixture
def kb_executor(temp_kb_dir):
    """Create KB executor with temp directory"""
    return KBExecutor(
        base_path=str(temp_kb_dir),
        gateway_url="http://localhost:8080",
        tenant="test-tenant"
    )

class TestKBExecutorInitialization:
    """Test KB executor initialization"""
    
    def test_init_with_valid_path(self, temp_kb_dir):
        """Should initialize successfully with valid path"""
        executor = KBExecutor(base_path=str(temp_kb_dir))
        assert executor.base_path == temp_kb_dir
        assert executor.cache_ttl == 3600
        assert executor.max_doc_size == 1048576
    
    def test_init_with_invalid_path(self):
        """Should raise error with invalid path"""
        with pytest.raises(ValueError, match="does not exist"):
            KBExecutor(base_path="/nonexistent/path")
    
    def test_init_with_file_instead_of_dir(self, temp_kb_dir):
        """Should raise error if path is a file"""
        file_path = temp_kb_dir / "test.txt"
        file_path.write_text("test")
        
        with pytest.raises(ValueError, match="not a directory"):
            KBExecutor(base_path=str(file_path))

class TestPathValidation:
    """Test path validation and security"""
    
    def test_validate_simple_filename(self, kb_executor):
        """Should accept simple .md filename"""
        path = kb_executor._validate_path("test.md")
        assert path.name == "test.md"
    
    def test_reject_path_with_separators(self, kb_executor):
        """Should reject paths with directory separators"""
        with pytest.raises(InvalidPathError, match="path separators"):
            kb_executor._validate_path("../secret.md")
        
        with pytest.raises(InvalidPathError, match="path separators"):
            kb_executor._validate_path("subdir/doc.md")
    
    def test_reject_non_md_files(self, kb_executor):
        """Should reject non-.md files"""
        with pytest.raises(InvalidPathError, match="Only .md files"):
            kb_executor._validate_path("test.txt")
        
        with pytest.raises(InvalidPathError, match="Only .md files"):
            kb_executor._validate_path("malicious.sh")
    
    def test_reject_directory_traversal(self, kb_executor):
        """Should prevent directory traversal attacks"""
        with pytest.raises(InvalidPathError):
            kb_executor._validate_path("../../etc/passwd.md")

class TestCaching:
    """Test document caching"""
    
    @pytest.mark.asyncio
    async def test_cache_hit(self, kb_executor):
        """Should return cached document on second call"""
        # First call - cache miss
        result1 = await kb_executor.get_doc("01-TEST-DOC.md", "TEST-001")
        assert result1["cache_hit"] is False
        
        # Second call - cache hit
        result2 = await kb_executor.get_doc("01-TEST-DOC.md", "TEST-001")
        assert result2["cache_hit"] is True
        assert result2["content"] == result1["content"]
    
    @pytest.mark.asyncio
    async def test_cache_expiry(self, kb_executor):
        """Should expire cache after TTL"""
        # Set very short TTL
        kb_executor.cache_ttl = 1
        
        # First call
        result1 = await kb_executor.get_doc("01-TEST-DOC.md", "TEST-001")
        assert result1["cache_hit"] is False
        
        # Wait for cache to expire
        await asyncio.sleep(1.1)
        
        # Second call should be cache miss
        result2 = await kb_executor.get_doc("01-TEST-DOC.md", "TEST-001")
        assert result2["cache_hit"] is False

class TestGetIndex:
    """Test get_index method"""
    
    @pytest.mark.asyncio
    @patch('kb_executor.KBExecutor._emit_oasis_event', new_callable=AsyncMock)
    async def test_get_index_all_docs(self, mock_emit, kb_executor):
        """Should return all documents"""
        result = await kb_executor.get_index(vtid="TEST-001")
        
        assert result["total"] == 3
        assert len(result["documents"]) == 3
        assert any(doc["name"] == "01-TEST-DOC.md" for doc in result["documents"])
        
        # Should emit events
        assert mock_emit.call_count == 2  # invoked + accessed
        
        # Check event types
        calls = [call[0][0] for call in mock_emit.call_args_list]
        assert "kb.skill_invoked" in calls
        assert "kb.index_accessed" in calls
    
    @pytest.mark.asyncio
    @patch('kb_executor.KBExecutor._emit_oasis_event', new_callable=AsyncMock)
    async def test_get_index_with_query(self, mock_emit, kb_executor):
        """Should filter documents by query"""
        result = await kb_executor.get_index(query="deployment", vtid="TEST-001")
        
        assert result["total"] == 1
        assert result["documents"][0]["name"] == "02-DEPLOYMENT.md"
        assert result["query"] == "deployment"
    
    @pytest.mark.asyncio
    @patch('kb_executor.KBExecutor._emit_oasis_event', new_callable=AsyncMock)
    async def test_get_index_categories(self, mock_emit, kb_executor):
        """Should categorize documents"""
        result = await kb_executor.get_index(vtid="TEST-001")
        
        assert "categories" in result
        assert isinstance(result["categories"], dict)
    
    @pytest.mark.asyncio
    @patch('kb_executor.KBExecutor._emit_oasis_event', new_callable=AsyncMock)
    async def test_get_index_bundles(self, mock_emit, kb_executor):
        """Should return available bundles"""
        result = await kb_executor.get_index(vtid="TEST-001")
        
        assert "bundles" in result
        assert "cicd_docs" in result["bundles"]
        assert "deployment_docs" in result["bundles"]

class TestGetDoc:
    """Test get_doc method"""
    
    @pytest.mark.asyncio
    @patch('kb_executor.KBExecutor._emit_oasis_event', new_callable=AsyncMock)
    async def test_get_doc_success(self, mock_emit, kb_executor):
        """Should retrieve document successfully"""
        result = await kb_executor.get_doc("01-TEST-DOC.md", "TEST-001")
        
        assert result["name"] == "01-TEST-DOC.md"
        assert "# Test Document" in result["content"]
        assert result["size"] > 0
        assert result["cache_hit"] is False
        
        # Should emit events
        assert mock_emit.call_count == 2  # invoked + accessed
        
        # Check success status
        last_call = mock_emit.call_args_list[-1]
        assert last_call[1]["status"] == "success"
    
    @pytest.mark.asyncio
    @patch('kb_executor.KBExecutor._emit_oasis_event', new_callable=AsyncMock)
    async def test_get_doc_not_found(self, mock_emit, kb_executor):
        """Should raise DocumentNotFoundError for missing doc"""
        with pytest.raises(DocumentNotFoundError, match="not found"):
            await kb_executor.get_doc("nonexistent.md", "TEST-001")
        
        # Should emit fail event
        last_call = mock_emit.call_args_list[-1]
        assert last_call[1]["status"] == "fail"
    
    @pytest.mark.asyncio
    @patch('kb_executor.KBExecutor._emit_oasis_event', new_callable=AsyncMock)
    async def test_get_doc_invalid_path(self, mock_emit, kb_executor):
        """Should raise InvalidPathError for invalid path"""
        with pytest.raises(InvalidPathError):
            await kb_executor.get_doc("../secret.md", "TEST-001")
        
        # Should emit fail event
        last_call = mock_emit.call_args_list[-1]
        assert last_call[1]["status"] == "fail"
    
    @pytest.mark.asyncio
    @patch('kb_executor.KBExecutor._emit_oasis_event', new_callable=AsyncMock)
    async def test_get_doc_size_limit(self, kb_executor, temp_kb_dir):
        """Should reject documents exceeding size limit"""
        # Create large document
        large_doc = temp_kb_dir / "large.md"
        large_doc.write_text("x" * (kb_executor.max_doc_size + 1))
        
        with pytest.raises(KBAccessError, match="too large"):
            await kb_executor.get_doc("large.md", "TEST-001")

class TestGetBundle:
    """Test get_bundle method"""
    
    @pytest.mark.asyncio
    @patch('kb_executor.KBExecutor._emit_oasis_event', new_callable=AsyncMock)
    async def test_get_bundle_by_name(self, mock_emit, kb_executor, temp_kb_dir):
        """Should retrieve bundle by name"""
        # Create bundle docs
        (temp_kb_dir / "05-CI-CD-PATTERNS.md").write_text("# CI/CD")
        (temp_kb_dir / "06-GITHUB-WORKFLOW.md").write_text("# GitHub")
        (temp_kb_dir / "07-GCP-DEPLOYMENT.md").write_text("# GCP")
        
        result = await kb_executor.get_bundle(bundle_name="cicd_docs", vtid="TEST-001")
        
        assert result["bundle_name"] == "cicd_docs"
        assert result["document_count"] == 3
        assert len(result["documents"]) == 3
        
        # Should emit bundle_created event
        bundle_events = [call for call in mock_emit.call_args_list 
                        if call[0][0] == "kb.bundle_created"]
        assert len(bundle_events) == 1
    
    @pytest.mark.asyncio
    @patch('kb_executor.KBExecutor._emit_oasis_event', new_callable=AsyncMock)
    async def test_get_bundle_by_doc_names(self, mock_emit, kb_executor):
        """Should retrieve bundle by custom doc names"""
        result = await kb_executor.get_bundle(
            doc_names=["01-TEST-DOC.md", "02-DEPLOYMENT.md"],
            vtid="TEST-001"
        )
        
        assert result["document_count"] == 2
        assert len(result["documents"]) == 2
    
    @pytest.mark.asyncio
    async def test_get_bundle_invalid_name(self, kb_executor):
        """Should raise ValueError for invalid bundle name"""
        with pytest.raises(ValueError, match="Unknown bundle"):
            await kb_executor.get_bundle(bundle_name="invalid_bundle", vtid="TEST-001")
    
    @pytest.mark.asyncio
    async def test_get_bundle_no_params(self, kb_executor):
        """Should raise ValueError if neither param provided"""
        with pytest.raises(ValueError, match="Must provide"):
            await kb_executor.get_bundle(vtid="TEST-001")
    
    @pytest.mark.asyncio
    @patch('kb_executor.KBExecutor._emit_oasis_event', new_callable=AsyncMock)
    async def test_get_bundle_partial_failure(self, mock_emit, kb_executor):
        """Should handle partial failures gracefully"""
        result = await kb_executor.get_bundle(
            doc_names=["01-TEST-DOC.md", "nonexistent.md"],
            vtid="TEST-001"
        )
        
        assert result["document_count"] == 1  # Only successful one
        assert len(result["failed_documents"]) == 1
        assert result["failed_documents"][0]["name"] == "nonexistent.md"

class TestOASISEventEmission:
    """Test OASIS event emission"""
    
    @pytest.mark.asyncio
    @patch('httpx.AsyncClient.post', new_callable=AsyncMock)
    async def test_emit_oasis_event_success(self, mock_post, kb_executor):
        """Should emit OASIS event successfully"""
        mock_post.return_value.status_code = 200
        
        await kb_executor._emit_oasis_event(
            "kb.test_event",
            "TEST-001",
            "planner",
            "vitana.kb.test",
            {"test": "data"},
            "success"
        )
        
        # Should call gateway
        assert mock_post.called
        call_args = mock_post.call_args
        
        # Check URL
        assert "/events/ingest" in call_args[0][0]
        
        # Check payload
        payload = call_args[1]["json"]
        assert payload["service"] == "crewai-kb-executor"
        assert payload["event"] == "kb.test_event"
        assert payload["tenant"] == "test-tenant"
        assert payload["status"] == "success"
        assert payload["metadata"]["vtid"] == "TEST-001"
        assert payload["metadata"]["agent_role"] == "planner"
    
    @pytest.mark.asyncio
    @patch('httpx.AsyncClient.post', new_callable=AsyncMock)
    async def test_emit_oasis_event_failure_silent(self, mock_post, kb_executor):
        """Should not raise if event emission fails"""
        mock_post.side_effect = Exception("Network error")
        
        # Should not raise
        await kb_executor._emit_oasis_event(
            "kb.test_event",
            "TEST-001",
            "planner",
            "vitana.kb.test",
            {},
            "success"
        )

class TestPerformance:
    """Test performance requirements"""
    
    @pytest.mark.asyncio
    async def test_get_index_performance(self, kb_executor):
        """Should complete get_index in < 50ms"""
        result = await kb_executor.get_index(vtid="TEST-001")
        assert result["execution_time_ms"] < 50
    
    @pytest.mark.asyncio
    async def test_get_doc_performance(self, kb_executor):
        """Should complete get_doc in < 100ms"""
        result = await kb_executor.get_doc("01-TEST-DOC.md", "TEST-001")
        assert result["execution_time_ms"] < 100
    
    @pytest.mark.asyncio
    async def test_get_doc_cached_performance(self, kb_executor):
        """Cached get_doc should be faster than initial"""
        # First call
        result1 = await kb_executor.get_doc("01-TEST-DOC.md", "TEST-001")
        time1 = result1["execution_time_ms"]
        
        # Second call (cached)
        result2 = await kb_executor.get_doc("01-TEST-DOC.md", "TEST-001")
        time2 = result2["execution_time_ms"]
        
        # Cached should be faster
        assert time2 < time1

if __name__ == "__main__":
    pytest.main([__file__, "-v"])
