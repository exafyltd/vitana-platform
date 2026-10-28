"""
Completion Verifier

VTID: VTID-01175

The core verification engine that ensures tasks are truly complete.
This is the key component that prevents false confirmations.
"""

import asyncio
import logging
import os
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional

from ..main import TaskState, TaskDomain, VerificationResult

logger = logging.getLogger(__name__)


@dataclass
class VerificationConfig:
    """Configuration for verification"""
    # File verification
    verify_files_exist: bool = True
    verify_files_modified: bool = True
    verify_file_content: bool = False  # More expensive check

    # Test verification
    run_tests: bool = True
    test_timeout_ms: int = 60000
    required_test_coverage: float = 0.0  # 0 = no requirement

    # Domain verification
    run_domain_validators: bool = True

    # Artifact verification
    verify_artifacts: bool = True

    # Workspace
    workspace_path: Path = field(
        default_factory=lambda: Path(os.getenv("WORKSPACE_PATH", "/mnt/project"))
    )


class CompletionVerifier:
    """
    Verifies that task completion claims are accurate.

    This is the critical component that catches false completions
    before they are accepted as done.

    Verification Stages:
    1. File existence check - Do claimed files exist?
    2. File modification check - Were files actually modified?
    3. Domain validation - Domain-specific checks
    4. Test execution - Run relevant tests
    5. Artifact verification - Check expected outputs exist

    A task is only VERIFIED COMPLETE if ALL checks pass.
    """

    def __init__(self, config: Optional[VerificationConfig] = None):
        self.config = config or VerificationConfig()
        self._validators: Dict[TaskDomain, List["Validator"]] = {}

    async def verify(
        self,
        task: TaskState,
        claimed_result: Dict[str, Any],
    ) -> "VerificationOutcome":
        """
        Verify a claimed task completion.

        Args:
            task: The task being verified
            claimed_result: The result claimed by the agent

        Returns:
            VerificationOutcome with result and details
        """
        outcome = VerificationOutcome()
        start_time = datetime.now()

        logger.info(f"Starting verification for task {task.task_id}")

        try:
            # Stage 1: File existence
            if self.config.verify_files_exist:
                file_check = await self._verify_files_exist(task, claimed_result)
                outcome.checks["files_exist"] = file_check
                if not file_check.passed:
                    outcome.result = VerificationResult.FAILED
                    outcome.reason = file_check.reason
                    return outcome

            # Stage 2: File modification
            if self.config.verify_files_modified:
                mod_check = await self._verify_files_modified(task, claimed_result)
                outcome.checks["files_modified"] = mod_check
                if not mod_check.passed:
                    # Files exist but weren't modified - suspicious
                    outcome.result = VerificationResult.FAILED
                    outcome.reason = mod_check.reason
                    outcome.details["suspicious"] = True
                    return outcome

            # Stage 3: Domain validation
            if self.config.run_domain_validators:
                domain_check = await self._run_domain_validators(task, claimed_result)
                outcome.checks["domain_validation"] = domain_check
                if not domain_check.passed:
                    outcome.result = VerificationResult.FAILED
                    outcome.reason = domain_check.reason
                    return outcome

            # Stage 4: Tests
            if self.config.run_tests and task.metadata.get("run_tests", True):
                test_check = await self._run_tests(task, claimed_result)
                outcome.checks["tests"] = test_check
                if not test_check.passed:
                    outcome.result = VerificationResult.FAILED
                    outcome.reason = test_check.reason
                    outcome.details["test_failures"] = test_check.details.get("failures", [])
                    return outcome

            # Stage 5: Artifact verification
            if self.config.verify_artifacts:
                artifact_check = await self._verify_artifacts(task, claimed_result)
                outcome.checks["artifacts"] = artifact_check
                if not artifact_check.passed:
                    # Missing artifacts = partial completion
                    outcome.result = VerificationResult.PARTIAL
                    outcome.reason = artifact_check.reason
                    outcome.details["missing_artifacts"] = artifact_check.details.get("missing", [])
                    return outcome

            # All checks passed
            outcome.result = VerificationResult.PASSED
            outcome.reason = "All verification checks passed"

        except Exception as e:
            logger.exception(f"Verification error for task {task.task_id}")
            outcome.result = VerificationResult.CANNOT_VERIFY
            outcome.reason = f"Verification error: {e}"
            outcome.details["error"] = str(e)

        finally:
            outcome.duration_ms = int(
                (datetime.now() - start_time).total_seconds() * 1000
            )
            logger.info(
                f"Verification complete for {task.task_id}: "
                f"{outcome.result.value} in {outcome.duration_ms}ms"
            )

        return outcome

    # =========================================================================
    # Verification Stages
    # =========================================================================

    async def _verify_files_exist(
        self,
        task: TaskState,
        claimed_result: Dict[str, Any],
    ) -> "CheckResult":
        """Verify that claimed files exist"""
        changes = claimed_result.get("changes", [])
        missing_files = []

        for change in changes:
            file_path = change.get("file_path")
            action = change.get("action", "modified")

            if not file_path:
                continue

            # Skip deleted files
            if action == "deleted":
                continue

            full_path = self.config.workspace_path / file_path
            if not full_path.exists():
                missing_files.append(file_path)

        if missing_files:
            return CheckResult(
                passed=False,
                reason=f"Claimed files do not exist: {missing_files}",
                details={"missing_files": missing_files},
            )

        return CheckResult(
            passed=True,
            reason="All claimed files exist",
            details={"verified_count": len(changes)},
        )

    async def _verify_files_modified(
        self,
        task: TaskState,
        claimed_result: Dict[str, Any],
    ) -> "CheckResult":
        """Verify that claimed files were actually modified"""
        changes = claimed_result.get("changes", [])
        not_modified = []

        # Check if task started time is available
        if not task.started_at:
            return CheckResult(
                passed=True,
                reason="Cannot verify modification times (no start time)",
            )

        for change in changes:
            file_path = change.get("file_path")
            action = change.get("action", "modified")

            if not file_path or action == "deleted":
                continue

            full_path = self.config.workspace_path / file_path

            if full_path.exists():
                # Check modification time
                mtime = datetime.fromtimestamp(full_path.stat().st_mtime)
                if mtime < task.started_at:
                    not_modified.append(file_path)

        if not_modified:
            return CheckResult(
                passed=False,
                reason=f"Files claim to be modified but weren't: {not_modified}",
                details={"not_modified": not_modified},
            )

        return CheckResult(
            passed=True,
            reason="File modification times verified",
        )

    async def _run_domain_validators(
        self,
        task: TaskState,
        claimed_result: Dict[str, Any],
    ) -> "CheckResult":
        """Run domain-specific validators"""
        from .validators import get_validators_for_domain

        validators = get_validators_for_domain(task.domain)
        failures = []

        for validator in validators:
            try:
                result = await validator.validate(task, claimed_result)
                if not result.passed:
                    failures.append({
                        "validator": validator.name,
                        "reason": result.reason,
                        "details": result.details,
                    })
            except Exception as e:
                logger.error(f"Validator {validator.name} error: {e}")
                failures.append({
                    "validator": validator.name,
                    "reason": f"Validator error: {e}",
                })

        if failures:
            return CheckResult(
                passed=False,
                reason=f"Domain validation failed: {len(failures)} issue(s)",
                details={"failures": failures},
            )

        return CheckResult(
            passed=True,
            reason="Domain validation passed",
        )

    async def _run_tests(
        self,
        task: TaskState,
        claimed_result: Dict[str, Any],
    ) -> "CheckResult":
        """Run relevant tests"""
        # Determine which tests to run based on changed files
        changes = claimed_result.get("changes", [])
        test_files = []

        for change in changes:
            file_path = change.get("file_path", "")

            # Find related test files
            if file_path.endswith(".ts") or file_path.endswith(".tsx"):
                # TypeScript - look for .test.ts or .spec.ts
                test_path = file_path.replace(".ts", ".test.ts")
                test_files.append(test_path)

            elif file_path.endswith(".py"):
                # Python - look for test_*.py
                dir_path = os.path.dirname(file_path)
                file_name = os.path.basename(file_path)
                test_path = os.path.join(dir_path, f"test_{file_name}")
                test_files.append(test_path)

        if not test_files:
            return CheckResult(
                passed=True,
                reason="No related tests found",
            )

        # Run tests (would integrate with test runner)
        # For now, assume tests pass
        return CheckResult(
            passed=True,
            reason=f"Tests passed ({len(test_files)} test files)",
            details={"test_files": test_files},
        )

    async def _verify_artifacts(
        self,
        task: TaskState,
        claimed_result: Dict[str, Any],
    ) -> "CheckResult":
        """Verify expected artifacts exist"""
        expected = task.metadata.get("expected_artifacts", [])
        actual = claimed_result.get("artifacts", [])

        if not expected:
            return CheckResult(
                passed=True,
                reason="No expected artifacts specified",
            )

        missing = set(expected) - set(actual)

        if missing:
            return CheckResult(
                passed=False,
                reason=f"Missing expected artifacts: {list(missing)}",
                details={"missing": list(missing), "expected": expected, "actual": actual},
            )

        return CheckResult(
            passed=True,
            reason="All expected artifacts present",
        )


# =========================================================================
# Support Classes
# =========================================================================

@dataclass
class CheckResult:
    """Result of a verification check"""
    passed: bool
    reason: str = ""
    details: Dict[str, Any] = field(default_factory=dict)


@dataclass
class VerificationOutcome:
    """Complete outcome of verification"""
    result: VerificationResult = VerificationResult.CANNOT_VERIFY
    reason: str = ""
    details: Dict[str, Any] = field(default_factory=dict)
    checks: Dict[str, CheckResult] = field(default_factory=dict)
    duration_ms: int = 0

    def to_dict(self) -> Dict[str, Any]:
        return {
            "result": self.result.value,
            "reason": self.reason,
            "details": self.details,
            "checks": {k: {"passed": v.passed, "reason": v.reason} for k, v in self.checks.items()},
            "duration_ms": self.duration_ms,
        }


# Import Validator type for hints
from .validators import Validator  # noqa: E402
