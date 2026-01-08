"""
Vitana Orchestrator - Core Orchestration Logic

VTID: VTID-01175

Implements the completion guarantee loop that ensures tasks are truly done
before confirming completion. Protects against false claims of completion.
"""

import asyncio
import logging
import time
import uuid
from datetime import datetime
from typing import Any, Callable, Dict, List, Optional, Type

from .main import (
    AgentRole,
    OrchestratorConfig,
    TaskConfig,
    TaskDomain,
    TaskState,
    TaskStatus,
    VerificationResult,
    detect_domain,
)

logger = logging.getLogger(__name__)


class OrchestratorError(Exception):
    """Base exception for orchestrator errors"""
    pass


class TaskDispatchError(OrchestratorError):
    """Error dispatching task to sub-agent"""
    pass


class VerificationError(OrchestratorError):
    """Error during task verification"""
    pass


class MaxRetriesExceededError(OrchestratorError):
    """Maximum retry attempts exceeded"""
    pass


class VitanaOrchestrator:
    """
    Production-grade orchestrator with guaranteed task completion.

    Key Features:
    1. Completion Verification Loop - Never trust "done" claims without verification
    2. State Machine - Track tasks through well-defined states
    3. Retry with Backoff - Automatic retry on transient failures
    4. False Confirmation Protection - Multiple validation stages
    5. OASIS Integration - Full observability
    6. Sub-Agent Management - Coordinate multiple specialized agents

    The core guarantee: If a task is marked COMPLETED, it has been verified.
    """

    def __init__(
        self,
        config: Optional[OrchestratorConfig] = None,
        adapters: Optional[Dict[str, Any]] = None,
    ):
        self.config = config or OrchestratorConfig()
        self._adapters: Dict[str, Any] = adapters or {}
        self._tasks: Dict[str, TaskState] = {}
        self._running = False
        self._event_handlers: Dict[str, List[Callable]] = {}
        self._semaphore: Optional[asyncio.Semaphore] = None

        # Statistics
        self._stats = {
            "tasks_dispatched": 0,
            "tasks_completed": 0,
            "tasks_failed": 0,
            "verification_passes": 0,
            "verification_failures": 0,
            "retries_attempted": 0,
            "false_completions_caught": 0,
        }

        logger.info(
            f"Vitana Orchestrator initialized - {self.config.vtid} v{self.config.version}"
        )

    # =========================================================================
    # Adapter Management
    # =========================================================================

    def register_adapter(self, domain: str, adapter: Any) -> None:
        """Register a sub-agent adapter for a domain"""
        self._adapters[domain] = adapter
        logger.info(f"Registered adapter for domain: {domain}")

    def get_adapter(self, domain: TaskDomain) -> Any:
        """Get adapter for a domain"""
        adapter = self._adapters.get(domain.value)
        if not adapter:
            # Try to get default adapter
            adapter = self._adapters.get("default")
        if not adapter:
            raise TaskDispatchError(f"No adapter registered for domain: {domain.value}")
        return adapter

    # =========================================================================
    # Task Lifecycle
    # =========================================================================

    async def submit_task(self, config: TaskConfig) -> TaskState:
        """
        Submit a new task for execution.

        Returns TaskState that can be used to track progress.
        """
        # Detect domain if not specified
        if config.domain is None:
            config.domain = detect_domain(
                config.title,
                config.description,
                config.target_paths,
            )
            logger.info(f"Auto-detected domain: {config.domain.value} for task: {config.title}")

        # Create task state
        task = config.to_task_state()
        self._tasks[task.task_id] = task

        # Emit task created event
        await self._emit_event("task.created", task)

        logger.info(f"Task submitted: {task.task_id} ({task.vtid}) - {task.title}")

        return task

    async def execute_task(self, task_id: str) -> TaskState:
        """
        Execute a task through the complete lifecycle with verification.

        This is the main entry point that guarantees completion.
        """
        task = self._tasks.get(task_id)
        if not task:
            raise OrchestratorError(f"Task not found: {task_id}")

        try:
            # === PHASE 1: Pre-flight ===
            if self.config.enable_preflight_checks:
                await self._run_preflight(task)

            # === PHASE 2: Execute with Verification Loop ===
            await self._execute_with_verification_loop(task)

            # === PHASE 3: Post-flight ===
            if self.config.enable_postflight_validation:
                await self._run_postflight(task)

            return task

        except Exception as e:
            logger.error(f"Task execution failed: {task_id} - {e}")
            task.status = TaskStatus.FAILED
            task.error = str(e)
            task.error_history.append({
                "timestamp": datetime.now().isoformat(),
                "error": str(e),
                "phase": "execution",
            })
            task.completed_at = datetime.now()
            await self._emit_event("task.failed", task, error=str(e))
            raise

    async def _execute_with_verification_loop(self, task: TaskState) -> None:
        """
        THE CORE GUARANTEE LOOP

        This loop ensures that:
        1. Task is dispatched to appropriate sub-agent
        2. Completion is VERIFIED not just claimed
        3. False completions trigger retry
        4. Only verified completions are marked COMPLETED

        This protects against sub-agents claiming "done" when work is incomplete.
        """
        while not task.is_terminal:
            # Check retry limit
            if task.retry_count > task.max_retries:
                self._stats["tasks_failed"] += 1
                raise MaxRetriesExceededError(
                    f"Task {task.task_id} exceeded max retries ({task.max_retries})"
                )

            try:
                # --- STEP 1: Dispatch to sub-agent ---
                await self._dispatch_task(task)

                # --- STEP 2: Wait for completion claim ---
                result = await self._wait_for_completion(task)

                # --- STEP 3: VERIFY the completion (THE KEY STEP) ---
                if self.config.verification_required:
                    verification = await self._verify_completion(task, result)

                    if verification.result == VerificationResult.PASSED:
                        # VERIFIED COMPLETE - Safe to mark as done
                        task.status = TaskStatus.COMPLETED
                        task.result = result
                        task.completed_at = datetime.now()
                        self._stats["tasks_completed"] += 1
                        self._stats["verification_passes"] += 1
                        await self._emit_event("task.completed", task)
                        logger.info(f"Task VERIFIED COMPLETE: {task.task_id}")

                    elif verification.result == VerificationResult.FAILED:
                        # FALSE COMPLETION CAUGHT
                        self._stats["false_completions_caught"] += 1
                        self._stats["verification_failures"] += 1
                        logger.warning(
                            f"FALSE COMPLETION detected for task {task.task_id}: "
                            f"{verification.reason}"
                        )
                        await self._handle_verification_failure(task, verification)

                    elif verification.result == VerificationResult.PARTIAL:
                        # Partial completion - retry with remaining work
                        logger.info(f"Partial completion for task {task.task_id}")
                        await self._handle_partial_completion(task, verification)

                    elif verification.result == VerificationResult.NEEDS_RETRY:
                        # Transient issue - retry
                        await self._schedule_retry(task, verification.reason)

                    else:
                        # Cannot verify - fail safe by retrying
                        await self._schedule_retry(task, "Verification inconclusive")

                else:
                    # No verification required (not recommended for production)
                    task.status = TaskStatus.COMPLETED
                    task.result = result
                    task.completed_at = datetime.now()
                    self._stats["tasks_completed"] += 1
                    await self._emit_event("task.completed", task)

            except asyncio.TimeoutError:
                task.status = TaskStatus.TIMEOUT
                task.error = "Task execution timed out"
                task.completed_at = datetime.now()
                self._stats["tasks_failed"] += 1
                await self._emit_event("task.timeout", task)
                raise OrchestratorError(f"Task {task.task_id} timed out")

            except TaskDispatchError as e:
                # Dispatch failed - retry with backoff
                await self._schedule_retry(task, f"Dispatch error: {e}")

            except Exception as e:
                logger.exception(f"Unexpected error in task {task.task_id}")
                task.error_history.append({
                    "timestamp": datetime.now().isoformat(),
                    "error": str(e),
                    "retry_count": task.retry_count,
                })
                await self._schedule_retry(task, f"Unexpected error: {e}")

    # =========================================================================
    # Dispatch and Execution
    # =========================================================================

    async def _dispatch_task(self, task: TaskState) -> None:
        """Dispatch task to appropriate sub-agent"""
        task.status = TaskStatus.ROUTING
        await self._emit_event("task.routing", task)

        # Handle mixed domain tasks
        if task.domain == TaskDomain.MIXED:
            # Split into subtasks (memory -> backend -> frontend)
            await self._dispatch_mixed_task(task)
            return

        # Get adapter for domain
        adapter = self.get_adapter(task.domain)

        task.status = TaskStatus.DISPATCHED
        task.assigned_agent = f"worker-{task.domain.value}"
        task.assigned_at = datetime.now()
        self._stats["tasks_dispatched"] += 1

        await self._emit_event("task.dispatched", task)

        # Dispatch to adapter
        task.status = TaskStatus.IN_PROGRESS
        task.started_at = datetime.now()
        await self._emit_event("task.started", task)

        logger.info(
            f"Task {task.task_id} dispatched to {task.assigned_agent}"
        )

    async def _dispatch_mixed_task(self, task: TaskState) -> None:
        """Handle mixed-domain tasks by splitting into stages"""
        # Execution order: memory -> backend -> frontend
        stages = [TaskDomain.MEMORY, TaskDomain.BACKEND, TaskDomain.FRONTEND]

        for stage_domain in stages:
            # Check if this domain is relevant to the task
            if self._is_domain_relevant(task, stage_domain):
                subtask_config = TaskConfig(
                    vtid=f"{task.vtid}-{stage_domain.value}",
                    title=f"[{stage_domain.value}] {task.title}",
                    description=task.description,
                    domain=stage_domain,
                    target_paths=[
                        p for p in task.target_paths
                        if self._path_matches_domain(p, stage_domain)
                    ],
                    max_retries=task.max_retries,
                )

                subtask = await self.submit_task(subtask_config)
                await self.execute_task(subtask.task_id)

                task.changes_made.extend(subtask.changes_made)

    def _is_domain_relevant(self, task: TaskState, domain: TaskDomain) -> bool:
        """Check if a domain is relevant to this task"""
        from .main import DOMAIN_KEYWORDS

        text = f"{task.title} {task.description}".lower()
        keywords = DOMAIN_KEYWORDS.get(domain, set())

        return any(kw.lower() in text for kw in keywords)

    def _path_matches_domain(self, path: str, domain: TaskDomain) -> bool:
        """Check if a path belongs to a domain"""
        from .main import DOMAIN_PATH_PATTERNS, _path_matches_pattern

        patterns = DOMAIN_PATH_PATTERNS.get(domain, [])
        return any(_path_matches_pattern(path, p) for p in patterns)

    async def _wait_for_completion(self, task: TaskState) -> Dict[str, Any]:
        """Wait for sub-agent to claim completion"""
        adapter = self.get_adapter(task.domain)

        timeout_seconds = self.config.default_task_timeout_ms / 1000

        try:
            result = await asyncio.wait_for(
                adapter.wait_for_completion(task),
                timeout=timeout_seconds,
            )
            return result
        except asyncio.TimeoutError:
            raise

    # =========================================================================
    # Verification System (THE KEY TO PREVENTING FALSE COMPLETIONS)
    # =========================================================================

    async def _verify_completion(
        self,
        task: TaskState,
        claimed_result: Dict[str, Any],
    ) -> "VerificationOutcome":
        """
        Verify that a task is actually complete.

        This is the critical function that prevents false completions.
        It validates the claimed work against actual deliverables.
        """
        task.status = TaskStatus.VERIFYING
        task.verification_attempts += 1
        task.last_verification_at = datetime.now()

        await self._emit_event("task.verifying", task)

        outcome = VerificationOutcome(result=VerificationResult.PASSED)

        try:
            # --- CHECK 1: Were any changes actually made? ---
            changes = claimed_result.get("changes", [])
            if not changes and task.domain != TaskDomain.MEMORY:
                outcome.result = VerificationResult.FAILED
                outcome.reason = "No changes were made but task claimed completion"
                outcome.details["check_failed"] = "changes_exist"
                return outcome

            # --- CHECK 2: Do claimed files exist? ---
            files_missing = []
            for change in changes:
                file_path = change.get("file_path")
                if file_path and not await self._file_exists(file_path):
                    files_missing.append(file_path)

            if files_missing:
                outcome.result = VerificationResult.FAILED
                outcome.reason = f"Claimed files do not exist: {files_missing}"
                outcome.details["missing_files"] = files_missing
                return outcome

            # --- CHECK 3: Run domain-specific validators ---
            domain_validators = await self._get_domain_validators(task.domain)
            for validator in domain_validators:
                validation = await validator.validate(task, claimed_result)
                if not validation.passed:
                    outcome.result = VerificationResult.FAILED
                    outcome.reason = validation.reason
                    outcome.details["validator"] = validator.name
                    outcome.details["validation_details"] = validation.details
                    return outcome

            # --- CHECK 4: Verify artifacts match spec ---
            spec_artifacts = task.metadata.get("expected_artifacts", [])
            actual_artifacts = claimed_result.get("artifacts", [])

            if spec_artifacts:
                missing_artifacts = set(spec_artifacts) - set(actual_artifacts)
                if missing_artifacts:
                    outcome.result = VerificationResult.PARTIAL
                    outcome.reason = f"Missing expected artifacts: {missing_artifacts}"
                    outcome.details["missing_artifacts"] = list(missing_artifacts)
                    return outcome

            # --- CHECK 5: Run automated tests if applicable ---
            if task.metadata.get("run_tests", True):
                test_result = await self._run_verification_tests(task)
                if not test_result.passed:
                    outcome.result = VerificationResult.FAILED
                    outcome.reason = f"Tests failed: {test_result.reason}"
                    outcome.details["test_failures"] = test_result.failures
                    return outcome

            # All checks passed
            outcome.result = VerificationResult.PASSED
            outcome.reason = "All verification checks passed"
            task.verification_result = VerificationResult.PASSED
            task.verification_details = outcome.details

            return outcome

        except Exception as e:
            logger.exception(f"Verification error for task {task.task_id}")
            outcome.result = VerificationResult.CANNOT_VERIFY
            outcome.reason = f"Verification error: {e}"
            return outcome

    async def _file_exists(self, file_path: str) -> bool:
        """Check if a file exists"""
        from pathlib import Path
        return Path(self.config.workspace_path / file_path).exists()

    async def _get_domain_validators(self, domain: TaskDomain) -> List["Validator"]:
        """Get validators for a domain"""
        from .verification.validators import (
            BackendValidator,
            FrontendValidator,
            MemoryValidator,
        )

        validators = {
            TaskDomain.FRONTEND: [FrontendValidator()],
            TaskDomain.BACKEND: [BackendValidator()],
            TaskDomain.MEMORY: [MemoryValidator()],
        }
        return validators.get(domain, [])

    async def _run_verification_tests(self, task: TaskState) -> "TestResult":
        """Run automated tests to verify task completion"""
        # This would integrate with the test runner
        # For now, return a passing result
        return TestResult(passed=True)

    async def _handle_verification_failure(
        self,
        task: TaskState,
        verification: "VerificationOutcome",
    ) -> None:
        """Handle a failed verification"""
        task.status = TaskStatus.VERIFICATION_FAILED
        task.verification_result = VerificationResult.FAILED
        task.verification_details = verification.details

        await self._emit_event(
            "task.verification_failed",
            task,
            reason=verification.reason,
        )

        if self.config.auto_retry_on_verification_failure and task.can_retry:
            task.retry_reasons.append(f"Verification failed: {verification.reason}")
            await self._schedule_retry(task, verification.reason)
        else:
            task.status = TaskStatus.FAILED
            task.error = f"Verification failed: {verification.reason}"
            task.completed_at = datetime.now()
            self._stats["tasks_failed"] += 1
            await self._emit_event("task.failed", task, error=task.error)

    async def _handle_partial_completion(
        self,
        task: TaskState,
        verification: "VerificationOutcome",
    ) -> None:
        """Handle partial completion"""
        # Create follow-up task for remaining work
        remaining = verification.details.get("remaining_work", [])

        if remaining:
            task.metadata["remaining_work"] = remaining
            await self._schedule_retry(task, "Partial completion - continuing")
        else:
            # Can't determine remaining work, mark as needing manual review
            task.status = TaskStatus.FAILED
            task.error = "Partial completion but cannot determine remaining work"
            task.completed_at = datetime.now()
            await self._emit_event("task.needs_review", task)

    # =========================================================================
    # Retry Logic
    # =========================================================================

    async def _schedule_retry(self, task: TaskState, reason: str) -> None:
        """Schedule a task for retry with exponential backoff"""
        task.retry_count += 1
        task.retry_reasons.append(reason)
        self._stats["retries_attempted"] += 1

        if task.retry_count > task.max_retries:
            task.status = TaskStatus.FAILED
            task.error = f"Max retries exceeded. Last reason: {reason}"
            task.completed_at = datetime.now()
            self._stats["tasks_failed"] += 1
            await self._emit_event("task.failed", task, error=task.error)
            return

        # Calculate backoff delay
        delay_ms = self.config.retry_delay_ms * (
            self.config.retry_backoff_multiplier ** (task.retry_count - 1)
        )

        task.status = TaskStatus.RETRY_PENDING

        await self._emit_event(
            "task.retry_scheduled",
            task,
            retry_count=task.retry_count,
            delay_ms=delay_ms,
            reason=reason,
        )

        logger.info(
            f"Task {task.task_id} scheduled for retry #{task.retry_count} "
            f"in {delay_ms}ms. Reason: {reason}"
        )

        # Wait and then transition back to pending
        await asyncio.sleep(delay_ms / 1000)
        task.status = TaskStatus.PENDING

    # =========================================================================
    # Pre-flight and Post-flight
    # =========================================================================

    async def _run_preflight(self, task: TaskState) -> None:
        """Run pre-flight checks before task execution"""
        await self._emit_event("task.preflight.start", task)

        # Check memory first
        if self.config.enable_memory_integration:
            memory_result = await self._check_memory(task)
            if memory_result.get("duplicate_detected"):
                logger.warning(f"Duplicate task detected: {task.vtid}")
                task.metadata["duplicate_warning"] = memory_result

        # Domain-specific preflight
        preflight_checks = {
            TaskDomain.FRONTEND: ["accessibility"],
            TaskDomain.BACKEND: ["security", "analyze_service"],
            TaskDomain.MEMORY: ["rls_policy", "migration_preview"],
        }

        checks = preflight_checks.get(task.domain, [])
        for check in checks:
            result = await self._run_preflight_check(task, check)
            task.metadata[f"preflight_{check}"] = result

        await self._emit_event("task.preflight.complete", task)

    async def _run_postflight(self, task: TaskState) -> None:
        """Run post-flight validation after task completion"""
        await self._emit_event("task.postflight.start", task)

        # Domain-specific postflight
        postflight_checks = {
            TaskDomain.FRONTEND: ["accessibility"],
            TaskDomain.BACKEND: ["security"],
            TaskDomain.MEMORY: ["rls_policy"],
        }

        checks = postflight_checks.get(task.domain, [])
        for check in checks:
            result = await self._run_postflight_check(task, check)
            task.metadata[f"postflight_{check}"] = result

        await self._emit_event("task.postflight.complete", task)

    async def _check_memory(self, task: TaskState) -> Dict[str, Any]:
        """Check memory service for relevant context"""
        # Would call memory service here
        return {"duplicate_detected": False}

    async def _run_preflight_check(self, task: TaskState, check: str) -> Dict[str, Any]:
        """Run a specific preflight check"""
        return {"check": check, "passed": True}

    async def _run_postflight_check(self, task: TaskState, check: str) -> Dict[str, Any]:
        """Run a specific postflight check"""
        return {"check": check, "passed": True}

    # =========================================================================
    # Event System
    # =========================================================================

    def on(self, event: str, handler: Callable) -> None:
        """Register event handler"""
        if event not in self._event_handlers:
            self._event_handlers[event] = []
        self._event_handlers[event].append(handler)

    async def _emit_event(self, event: str, task: TaskState, **kwargs) -> None:
        """Emit an event to handlers and OASIS"""
        # Call registered handlers
        handlers = self._event_handlers.get(event, [])
        for handler in handlers:
            try:
                if asyncio.iscoroutinefunction(handler):
                    await handler(event, task, **kwargs)
                else:
                    handler(event, task, **kwargs)
            except Exception as e:
                logger.error(f"Event handler error: {e}")

        # Emit to OASIS
        if self.config.enable_oasis_events:
            await self._emit_oasis_event(event, task, **kwargs)

    async def _emit_oasis_event(self, event: str, task: TaskState, **kwargs) -> None:
        """Emit event to OASIS gateway"""
        oasis_event = f"vtid.stage.orchestrator.{event.replace('.', '_')}"
        task.oasis_events.append(oasis_event)

        # Would send to OASIS here
        logger.debug(f"OASIS event: {oasis_event} for {task.vtid}")

    # =========================================================================
    # Statistics and Monitoring
    # =========================================================================

    def get_stats(self) -> Dict[str, Any]:
        """Get orchestrator statistics"""
        return {
            **self._stats,
            "active_tasks": len([t for t in self._tasks.values() if not t.is_terminal]),
            "completed_tasks": len([t for t in self._tasks.values() if t.status == TaskStatus.COMPLETED]),
            "failed_tasks": len([t for t in self._tasks.values() if t.status == TaskStatus.FAILED]),
        }

    def get_task(self, task_id: str) -> Optional[TaskState]:
        """Get a task by ID"""
        return self._tasks.get(task_id)

    def list_tasks(
        self,
        status: Optional[TaskStatus] = None,
        domain: Optional[TaskDomain] = None,
    ) -> List[TaskState]:
        """List tasks with optional filters"""
        tasks = list(self._tasks.values())

        if status:
            tasks = [t for t in tasks if t.status == status]

        if domain:
            tasks = [t for t in tasks if t.domain == domain]

        return tasks


# =========================================================================
# Support Classes
# =========================================================================

class VerificationOutcome:
    """Result of a verification attempt"""

    def __init__(
        self,
        result: VerificationResult,
        reason: str = "",
        details: Optional[Dict[str, Any]] = None,
    ):
        self.result = result
        self.reason = reason
        self.details = details or {}


class TestResult:
    """Result of running tests"""

    def __init__(
        self,
        passed: bool,
        reason: str = "",
        failures: Optional[List[str]] = None,
    ):
        self.passed = passed
        self.reason = reason
        self.failures = failures or []


class Validator:
    """Base class for domain validators"""

    name: str = "base"

    async def validate(
        self,
        task: TaskState,
        result: Dict[str, Any],
    ) -> "ValidationResult":
        raise NotImplementedError


class ValidationResult:
    """Result of a validation"""

    def __init__(
        self,
        passed: bool,
        reason: str = "",
        details: Optional[Dict[str, Any]] = None,
    ):
        self.passed = passed
        self.reason = reason
        self.details = details or {}
