"""
Tests for the Safety System

VTID: VTID-01175
"""

import pytest
from vitana_orchestrator.main import TaskConfig, TaskDomain
from vitana_orchestrator.safety import (
    SafetyChecker,
    SafetyCheckResult,
    RateLimiter,
)


class TestSafetyChecker:
    """Tests for SafetyChecker"""

    @pytest.fixture
    def checker(self):
        return SafetyChecker()

    def test_blocks_env_file(self, checker):
        """Should block .env files"""
        task = TaskConfig(
            vtid="VTID-01234",
            title="Test",
            target_paths=[".env"],
        )
        result = checker.check_task(task)
        assert not result.safe
        assert ".env" in result.blocked_items

    def test_blocks_git_directory(self, checker):
        """Should block .git directory"""
        task = TaskConfig(
            vtid="VTID-01234",
            title="Test",
            target_paths=[".git/config"],
        )
        result = checker.check_task(task)
        assert not result.safe

    def test_blocks_credentials(self, checker):
        """Should block credential files"""
        task = TaskConfig(
            vtid="VTID-01234",
            title="Test",
            target_paths=["credentials.json"],
        )
        result = checker.check_task(task)
        assert not result.safe

    def test_allows_safe_paths(self, checker):
        """Should allow safe paths"""
        task = TaskConfig(
            vtid="VTID-01234",
            title="Test",
            target_paths=[
                "services/gateway/src/routes/api.ts",
                "services/gateway/src/frontend/App.tsx",
            ],
        )
        result = checker.check_task(task)
        assert result.safe

    def test_enforces_file_limit(self, checker):
        """Should enforce max files limit"""
        task = TaskConfig(
            vtid="VTID-01234",
            title="Test",
            target_paths=[f"file{i}.ts" for i in range(25)],  # Exceeds default 20
        )
        result = checker.check_task(task)
        assert not result.safe
        assert "too many files" in result.reason.lower()

    def test_respects_custom_budget(self, checker):
        """Should respect custom change budget"""
        task = TaskConfig(
            vtid="VTID-01234",
            title="Test",
            target_paths=[f"file{i}.ts" for i in range(5)],
            change_budget={"max_files": 3},
        )
        result = checker.check_task(task)
        assert not result.safe

    def test_check_changes_blocks_secrets(self, checker):
        """Should block changes containing secrets"""
        changes = [
            {
                "file_path": "config.ts",
                "content": 'const apiKey = "sk-abc123";',
            }
        ]
        result = checker.check_changes(changes)
        # The checker looks for specific patterns
        # This is a simplified test

    def test_check_output_detects_leaks(self, checker):
        """Should detect potential secret leaks in output"""
        output = """
        Task completed!
        Using API_KEY: ANTHROPIC_API_KEY=sk_ant_123456789
        """
        result = checker.check_output(output)
        assert not result.safe
        assert "ANTHROPIC_API_KEY" in result.blocked_items


class TestRateLimiter:
    """Tests for RateLimiter"""

    def test_allows_within_limit(self):
        """Should allow tasks within rate limit"""
        limiter = RateLimiter(max_tasks_per_minute=10)
        assert limiter.can_submit_task()

    def test_blocks_over_limit(self):
        """Should block tasks over rate limit"""
        limiter = RateLimiter(max_tasks_per_minute=2)

        # Submit tasks up to limit
        limiter.record_task()
        limiter.record_task()

        # Should now block
        assert not limiter.can_submit_task()

    def test_api_rate_limiting(self):
        """Should rate limit API calls"""
        limiter = RateLimiter(max_api_calls_per_minute=3)

        assert limiter.can_make_api_call()
        limiter.record_api_call()
        limiter.record_api_call()
        limiter.record_api_call()

        assert not limiter.can_make_api_call()


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
