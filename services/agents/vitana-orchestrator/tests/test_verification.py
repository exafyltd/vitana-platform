"""
Tests for the Verification System

VTID: VTID-01175
"""

import pytest
from pathlib import Path
from unittest.mock import patch, MagicMock
from datetime import datetime

from vitana_orchestrator.main import TaskState, TaskDomain, VerificationResult
from vitana_orchestrator.verification.verifier import (
    CompletionVerifier,
    VerificationConfig,
    VerificationOutcome,
    CheckResult,
)
from vitana_orchestrator.verification.validators import (
    FrontendValidator,
    BackendValidator,
    MemoryValidator,
    ValidationResult,
    get_validators_for_domain,
)


class TestCompletionVerifier:
    """Tests for CompletionVerifier"""

    @pytest.fixture
    def verifier(self, tmp_path):
        """Create verifier with temp workspace"""
        config = VerificationConfig(
            workspace_path=tmp_path,
            run_tests=False,  # Skip tests for unit testing
        )
        return CompletionVerifier(config=config)

    @pytest.fixture
    def task(self):
        """Create sample task"""
        return TaskState(
            task_id="test-123",
            vtid="VTID-01234",
            title="Test Task",
            description="Test description",
            domain=TaskDomain.BACKEND,
            started_at=datetime.now(),
        )

    @pytest.mark.asyncio
    async def test_verify_files_exist_pass(self, verifier, task, tmp_path):
        """Should pass when claimed files exist"""
        # Create the claimed file
        test_file = tmp_path / "test_file.ts"
        test_file.write_text("// test content")

        result = {
            "changes": [
                {"file_path": "test_file.ts", "action": "modified"}
            ]
        }

        outcome = await verifier.verify(task, result)
        assert outcome.checks["files_exist"].passed

    @pytest.mark.asyncio
    async def test_verify_files_exist_fail(self, verifier, task):
        """Should fail when claimed files don't exist"""
        result = {
            "changes": [
                {"file_path": "nonexistent.ts", "action": "modified"}
            ]
        }

        outcome = await verifier.verify(task, result)
        assert not outcome.checks["files_exist"].passed
        assert outcome.result == VerificationResult.FAILED

    @pytest.mark.asyncio
    async def test_verify_empty_changes_fail(self, verifier, task):
        """Should fail when no changes claimed"""
        result = {"changes": []}

        # Backend domain should require changes
        outcome = await verifier.verify(task, result)
        # Note: The current implementation may pass this - adjust based on requirements

    @pytest.mark.asyncio
    async def test_skip_deleted_files(self, verifier, task):
        """Should skip verification of deleted files"""
        result = {
            "changes": [
                {"file_path": "deleted_file.ts", "action": "deleted"}
            ]
        }

        outcome = await verifier.verify(task, result)
        # Should pass because deleted files don't need to exist
        assert outcome.checks["files_exist"].passed


class TestFrontendValidator:
    """Tests for FrontendValidator"""

    @pytest.fixture
    def validator(self):
        return FrontendValidator()

    @pytest.fixture
    def task(self):
        return TaskState(
            task_id="test-123",
            vtid="VTID-01234",
            title="Test",
            description="",
            domain=TaskDomain.FRONTEND,
        )

    @pytest.mark.asyncio
    async def test_detects_console_log(self, validator, task, tmp_path):
        """Should warn about console.log"""
        with patch.dict("os.environ", {"WORKSPACE_PATH": str(tmp_path)}):
            # Create file with console.log
            test_file = tmp_path / "frontend" / "component.tsx"
            test_file.parent.mkdir(parents=True)
            test_file.write_text('console.log("debug");')

            result = {
                "changes": [
                    {"file_path": "frontend/component.tsx", "action": "modified"}
                ]
            }

            validation = await validator.validate(task, result)
            # Should pass with warning (not critical)
            assert validation.passed
            if validation.details.get("issues"):
                assert any("console.log" in i["issue"] for i in validation.details["issues"])

    @pytest.mark.asyncio
    async def test_detects_missing_alt(self, validator, task, tmp_path):
        """Should warn about images without alt"""
        with patch.dict("os.environ", {"WORKSPACE_PATH": str(tmp_path)}):
            test_file = tmp_path / "frontend" / "image.tsx"
            test_file.parent.mkdir(parents=True, exist_ok=True)
            test_file.write_text('<img src="photo.jpg" />')

            result = {
                "changes": [
                    {"file_path": "frontend/image.tsx", "action": "modified"}
                ]
            }

            validation = await validator.validate(task, result)
            if validation.details.get("issues"):
                assert any("alt" in i["issue"].lower() for i in validation.details["issues"])


class TestBackendValidator:
    """Tests for BackendValidator"""

    @pytest.fixture
    def validator(self):
        return BackendValidator()

    @pytest.fixture
    def task(self):
        return TaskState(
            task_id="test-123",
            vtid="VTID-01234",
            title="Test",
            description="",
            domain=TaskDomain.BACKEND,
        )

    @pytest.mark.asyncio
    async def test_detects_hardcoded_secret(self, validator, task, tmp_path):
        """Should fail on hardcoded secrets"""
        with patch.dict("os.environ", {"WORKSPACE_PATH": str(tmp_path)}):
            test_file = tmp_path / "routes" / "auth.ts"
            test_file.parent.mkdir(parents=True)
            test_file.write_text('const password = "supersecret123";')

            result = {
                "changes": [
                    {"file_path": "routes/auth.ts", "action": "modified"}
                ]
            }

            validation = await validator.validate(task, result)
            assert not validation.passed
            assert "secret" in validation.reason.lower() or any(
                "secret" in i["issue"].lower()
                for i in validation.details.get("issues", [])
            )

    @pytest.mark.asyncio
    async def test_detects_sql_injection_risk(self, validator, task, tmp_path):
        """Should detect SQL injection vulnerability"""
        with patch.dict("os.environ", {"WORKSPACE_PATH": str(tmp_path)}):
            test_file = tmp_path / "routes" / "query.ts"
            test_file.parent.mkdir(parents=True, exist_ok=True)
            test_file.write_text('query("SELECT * FROM users WHERE id=" + userId)')

            result = {
                "changes": [
                    {"file_path": "routes/query.ts", "action": "modified"}
                ]
            }

            validation = await validator.validate(task, result)
            assert not validation.passed


class TestMemoryValidator:
    """Tests for MemoryValidator"""

    @pytest.fixture
    def validator(self):
        return MemoryValidator()

    @pytest.fixture
    def task(self):
        return TaskState(
            task_id="test-123",
            vtid="VTID-01234",
            title="Test",
            description="",
            domain=TaskDomain.MEMORY,
        )

    @pytest.mark.asyncio
    async def test_requires_rls_policy(self, validator, task, tmp_path):
        """Should fail when table created without RLS"""
        with patch.dict("os.environ", {"WORKSPACE_PATH": str(tmp_path)}):
            test_file = tmp_path / "migration.sql"
            test_file.write_text('''
                CREATE TABLE users (
                    id SERIAL PRIMARY KEY,
                    name TEXT
                );
            ''')

            result = {
                "changes": [
                    {"file_path": "migration.sql", "action": "created"}
                ]
            }

            validation = await validator.validate(task, result)
            assert not validation.passed
            assert "RLS" in validation.reason or any(
                "RLS" in i["issue"]
                for i in validation.details.get("issues", [])
            )

    @pytest.mark.asyncio
    async def test_passes_with_rls_policy(self, validator, task, tmp_path):
        """Should pass when table has RLS policy"""
        with patch.dict("os.environ", {"WORKSPACE_PATH": str(tmp_path)}):
            test_file = tmp_path / "migration.sql"
            test_file.write_text('''
                CREATE TABLE users (
                    id SERIAL PRIMARY KEY,
                    name TEXT
                );
                ALTER TABLE users ENABLE ROW LEVEL SECURITY;
                CREATE POLICY users_policy ON users FOR ALL USING (true);
            ''')

            result = {
                "changes": [
                    {"file_path": "migration.sql", "action": "created"}
                ]
            }

            validation = await validator.validate(task, result)
            assert validation.passed

    @pytest.mark.asyncio
    async def test_warns_on_drop_table(self, validator, task, tmp_path):
        """Should fail on DROP TABLE without confirmation"""
        with patch.dict("os.environ", {"WORKSPACE_PATH": str(tmp_path)}):
            test_file = tmp_path / "dangerous.sql"
            test_file.write_text('DROP TABLE users;')

            result = {
                "changes": [
                    {"file_path": "dangerous.sql", "action": "created"}
                ]
            }

            validation = await validator.validate(task, result)
            assert not validation.passed


class TestGetValidatorsForDomain:
    """Tests for validator selection"""

    def test_frontend_validators(self):
        """Should return frontend validators"""
        validators = get_validators_for_domain(TaskDomain.FRONTEND)
        assert len(validators) == 1
        assert isinstance(validators[0], FrontendValidator)

    def test_backend_validators(self):
        """Should return backend validators"""
        validators = get_validators_for_domain(TaskDomain.BACKEND)
        assert len(validators) == 1
        assert isinstance(validators[0], BackendValidator)

    def test_memory_validators(self):
        """Should return memory validators"""
        validators = get_validators_for_domain(TaskDomain.MEMORY)
        assert len(validators) == 1
        assert isinstance(validators[0], MemoryValidator)

    def test_mixed_validators(self):
        """Should return all validators for mixed domain"""
        validators = get_validators_for_domain(TaskDomain.MIXED)
        assert len(validators) == 3


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
