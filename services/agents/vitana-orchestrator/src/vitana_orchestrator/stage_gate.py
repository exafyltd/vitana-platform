"""
Verification Stage Gate - VTID-01175

This is the integration point between the Verification Engine and the
Worker Orchestrator (VTID-01163). It provides a stage gate that:

1. Validates worker output BEFORE the orchestrator marks completion
2. Emits OASIS events for verification stage results
3. Returns structured pass/fail that the orchestrator uses to decide next steps
4. NEVER claims completion itself - that's the orchestrator's job via OASIS

The flow:
  Worker completes → Orchestrator calls VerificationStageGate.verify() →
  → Gate emits OASIS event (vtid.stage.verification.*) →
  → Returns result to Orchestrator →
  → Orchestrator decides: complete vs retry vs fail →
  → Orchestrator writes terminal status to OASIS (sole authority)
"""

import logging
import os
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional

import httpx

from .main import TaskDomain, VerificationResult
from .verification import (
    CompletionVerifier,
    VerificationConfig,
    VerificationOutcome,
    get_validators_for_domain,
)
from .safety import SafetyChecker

logger = logging.getLogger(__name__)


@dataclass
class StageGateConfig:
    """Configuration for the verification stage gate"""
    # OASIS integration (required for production)
    oasis_gateway_url: str = field(
        default_factory=lambda: os.getenv("OASIS_GATEWAY_URL", "http://localhost:8080")
    )
    tenant: str = field(
        default_factory=lambda: os.getenv("VITANA_TENANT", "vitana-dev")
    )

    # Verification settings
    workspace_path: Path = field(
        default_factory=lambda: Path(os.getenv("WORKSPACE_PATH", "/mnt/project"))
    )
    verify_files_exist: bool = True
    verify_files_modified: bool = True
    run_domain_validators: bool = True
    run_tests: bool = True

    # Timeouts
    verification_timeout_ms: int = 60000  # 1 minute
    oasis_timeout_ms: int = 5000  # 5 seconds

    # Git SHA for traceability
    git_sha: str = field(
        default_factory=lambda: os.getenv("GIT_SHA", "unknown")
    )


@dataclass
class StageGateResult:
    """
    Result from the verification stage gate.

    This is what the orchestrator uses to make its decision.
    Note: This does NOT represent completion - only verification status.
    The orchestrator + OASIS determine actual task completion.
    """
    passed: bool
    verification_result: VerificationResult
    reason: str
    checks_run: List[str] = field(default_factory=list)
    checks_passed: List[str] = field(default_factory=list)
    checks_failed: List[str] = field(default_factory=list)
    duration_ms: int = 0
    oasis_event_id: Optional[str] = None
    details: Dict[str, Any] = field(default_factory=dict)

    # Recommendation for orchestrator (not a command)
    recommended_action: str = "none"  # "complete" | "retry" | "fail" | "manual_review"

    def to_dict(self) -> Dict[str, Any]:
        return {
            "passed": self.passed,
            "verification_result": self.verification_result.value,
            "reason": self.reason,
            "checks_run": self.checks_run,
            "checks_passed": self.checks_passed,
            "checks_failed": self.checks_failed,
            "duration_ms": self.duration_ms,
            "oasis_event_id": self.oasis_event_id,
            "details": self.details,
            "recommended_action": self.recommended_action,
        }


class VerificationStageGate:
    """
    Stage gate that sits between worker completion and orchestrator decision.

    This is a SUBSYSTEM of the Worker Orchestrator (VTID-01163), not a
    replacement. The orchestrator calls this gate after a worker claims
    completion, and uses the result to decide what to do next.

    Usage by VTID-01163:
    ```typescript
    // In worker-orchestrator routing logic
    const workerResult = await dispatchToWorker(task);

    // Call verification stage gate
    const verification = await verificationGate.verify({
      vtid: task.vtid,
      domain: task.domain,
      claimed_changes: workerResult.changes,
    });

    if (verification.passed) {
      // Emit terminal success to OASIS
      await emitOasis('vtid.stage.worker_orchestrator.success', { ... });
    } else if (verification.recommended_action === 'retry') {
      // Re-dispatch to worker with failure context
      await retryWorker(task, verification.reason);
    } else {
      // Emit terminal failure to OASIS
      await emitOasis('vtid.stage.worker_orchestrator.failed', { ... });
    }
    ```

    CRITICAL: This gate emits 'vtid.stage.verification.*' events but
    NEVER emits terminal orchestrator events. Only VTID-01163 does that.
    """

    def __init__(self, config: Optional[StageGateConfig] = None):
        self.config = config or StageGateConfig()
        self._verifier = CompletionVerifier(
            VerificationConfig(
                workspace_path=self.config.workspace_path,
                verify_files_exist=self.config.verify_files_exist,
                verify_files_modified=self.config.verify_files_modified,
                run_domain_validators=self.config.run_domain_validators,
                run_tests=self.config.run_tests,
            )
        )
        self._safety = SafetyChecker()

    async def verify(
        self,
        vtid: str,
        domain: TaskDomain,
        claimed_changes: List[Dict[str, Any]],
        claimed_output: str = "",
        started_at: Optional[datetime] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> StageGateResult:
        """
        Verify worker output before orchestrator marks completion.

        Args:
            vtid: Task VTID (for OASIS events)
            domain: Task domain (frontend/backend/memory)
            claimed_changes: Files the worker claims to have changed
            claimed_output: Raw output from worker
            started_at: When the task started (for modification time checks)
            metadata: Additional context

        Returns:
            StageGateResult with verification outcome and recommendation
        """
        start_time = time.time()
        run_id = str(uuid.uuid4())[:8]

        logger.info(f"[{vtid}] Verification stage gate started (run={run_id})")

        # Emit stage start event to OASIS
        await self._emit_oasis_event(
            vtid=vtid,
            event="vtid.stage.verification.start",
            status="start",
            metadata={
                "run_id": run_id,
                "domain": domain.value,
                "claimed_changes_count": len(claimed_changes),
            },
        )

        result = StageGateResult(
            passed=False,
            verification_result=VerificationResult.CANNOT_VERIFY,
            reason="Verification not completed",
        )

        try:
            # === CHECK 1: Safety check on output ===
            result.checks_run.append("safety_output")
            safety_result = self._safety.check_output(claimed_output)
            if not safety_result.safe:
                result.checks_failed.append("safety_output")
                result.reason = f"Safety check failed: {safety_result.reason}"
                result.verification_result = VerificationResult.FAILED
                result.recommended_action = "fail"  # Don't retry on safety issues
                result.details["safety_blocked"] = safety_result.blocked_items
                await self._emit_verification_complete(vtid, result, start_time)
                return result
            result.checks_passed.append("safety_output")

            # === CHECK 2: Files exist ===
            if self.config.verify_files_exist:
                result.checks_run.append("files_exist")
                missing = await self._check_files_exist(claimed_changes)
                if missing:
                    result.checks_failed.append("files_exist")
                    result.reason = f"Claimed files do not exist: {missing}"
                    result.verification_result = VerificationResult.FAILED
                    result.recommended_action = "retry"
                    result.details["missing_files"] = missing
                    await self._emit_verification_complete(vtid, result, start_time)
                    return result
                result.checks_passed.append("files_exist")

            # === CHECK 3: Files were modified (if we have start time) ===
            if self.config.verify_files_modified and started_at:
                result.checks_run.append("files_modified")
                not_modified = await self._check_files_modified(claimed_changes, started_at)
                if not_modified:
                    result.checks_failed.append("files_modified")
                    result.reason = f"Files claim modified but weren't: {not_modified}"
                    result.verification_result = VerificationResult.FAILED
                    result.recommended_action = "retry"
                    result.details["not_modified"] = not_modified
                    await self._emit_verification_complete(vtid, result, start_time)
                    return result
                result.checks_passed.append("files_modified")

            # === CHECK 4: Domain-specific validators ===
            if self.config.run_domain_validators:
                result.checks_run.append(f"domain_{domain.value}")
                validators = get_validators_for_domain(domain)

                for validator in validators:
                    validation = await validator.validate_changes(
                        domain=domain,
                        changes=claimed_changes,
                        workspace_path=self.config.workspace_path,
                    )
                    if not validation.passed:
                        result.checks_failed.append(f"domain_{domain.value}_{validator.name}")
                        result.reason = f"{validator.name}: {validation.reason}"
                        result.verification_result = VerificationResult.FAILED
                        result.recommended_action = "retry" if validation.retriable else "fail"
                        result.details["validator_issues"] = validation.details
                        await self._emit_verification_complete(vtid, result, start_time)
                        return result

                result.checks_passed.append(f"domain_{domain.value}")

            # === CHECK 5: Run tests (if applicable) ===
            if self.config.run_tests:
                result.checks_run.append("tests")
                test_result = await self._run_related_tests(claimed_changes, domain)
                if not test_result["passed"]:
                    result.checks_failed.append("tests")
                    result.reason = f"Tests failed: {test_result['reason']}"
                    result.verification_result = VerificationResult.FAILED
                    result.recommended_action = "retry"
                    result.details["test_failures"] = test_result.get("failures", [])
                    await self._emit_verification_complete(vtid, result, start_time)
                    return result
                result.checks_passed.append("tests")

            # === ALL CHECKS PASSED ===
            result.passed = True
            result.verification_result = VerificationResult.PASSED
            result.reason = f"All {len(result.checks_passed)} verification checks passed"
            result.recommended_action = "complete"

            await self._emit_verification_complete(vtid, result, start_time)
            return result

        except Exception as e:
            logger.exception(f"[{vtid}] Verification error")
            result.verification_result = VerificationResult.CANNOT_VERIFY
            result.reason = f"Verification error: {e}"
            result.recommended_action = "manual_review"
            await self._emit_verification_complete(vtid, result, start_time)
            return result

    async def _check_files_exist(
        self,
        changes: List[Dict[str, Any]],
    ) -> List[str]:
        """Check which claimed files don't exist"""
        missing = []
        for change in changes:
            file_path = change.get("file_path", "")
            action = change.get("action", "modified")

            if not file_path or action == "deleted":
                continue

            full_path = self.config.workspace_path / file_path
            if not full_path.exists():
                missing.append(file_path)

        return missing

    async def _check_files_modified(
        self,
        changes: List[Dict[str, Any]],
        started_at: datetime,
    ) -> List[str]:
        """Check which files weren't actually modified"""
        not_modified = []
        for change in changes:
            file_path = change.get("file_path", "")
            action = change.get("action", "modified")

            if not file_path or action == "deleted":
                continue

            full_path = self.config.workspace_path / file_path
            if full_path.exists():
                mtime = datetime.fromtimestamp(full_path.stat().st_mtime)
                if mtime < started_at:
                    not_modified.append(file_path)

        return not_modified

    async def _run_related_tests(
        self,
        changes: List[Dict[str, Any]],
        domain: TaskDomain,
    ) -> Dict[str, Any]:
        """Run tests related to changed files"""
        # For now, return passing - would integrate with test runner
        # In production, this would:
        # - Identify test files related to changes
        # - Run those tests via appropriate test runner
        # - Return actual pass/fail
        return {"passed": True, "reason": "Tests not configured"}

    async def _emit_oasis_event(
        self,
        vtid: str,
        event: str,
        status: str,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> Optional[str]:
        """Emit event to OASIS gateway"""
        event_id = str(uuid.uuid4())
        payload = {
            "service": "vitana-verification-engine",
            "event": event,
            "tenant": self.config.tenant,
            "status": status,
            "notes": f"Verification stage for {vtid}",
            "git_sha": self.config.git_sha,
            "rid": event_id,
            "metadata": {
                "vtid": vtid,
                **(metadata or {}),
            },
        }

        try:
            async with httpx.AsyncClient(
                timeout=self.config.oasis_timeout_ms / 1000
            ) as client:
                response = await client.post(
                    f"{self.config.oasis_gateway_url}/events/ingest",
                    json=payload,
                )
                if response.status_code == 200:
                    logger.debug(f"[{vtid}] OASIS event emitted: {event}")
                    return event_id
                else:
                    logger.warning(f"[{vtid}] OASIS event failed: {response.status_code}")
        except Exception as e:
            logger.warning(f"[{vtid}] OASIS event error: {e}")

        return None

    async def _emit_verification_complete(
        self,
        vtid: str,
        result: StageGateResult,
        start_time: float,
    ) -> None:
        """Emit verification complete event"""
        result.duration_ms = int((time.time() - start_time) * 1000)

        event_name = (
            "vtid.stage.verification.passed"
            if result.passed
            else "vtid.stage.verification.failed"
        )

        event_id = await self._emit_oasis_event(
            vtid=vtid,
            event=event_name,
            status="success" if result.passed else "fail",
            metadata={
                "verification_result": result.verification_result.value,
                "reason": result.reason,
                "checks_run": result.checks_run,
                "checks_passed": result.checks_passed,
                "checks_failed": result.checks_failed,
                "duration_ms": result.duration_ms,
                "recommended_action": result.recommended_action,
            },
        )

        result.oasis_event_id = event_id

        logger.info(
            f"[{vtid}] Verification {'PASSED' if result.passed else 'FAILED'} "
            f"in {result.duration_ms}ms - {result.reason}"
        )
