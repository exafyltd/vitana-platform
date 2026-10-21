"""
Mock Adapter for Testing

VTID: VTID-01175

A mock adapter for testing the orchestrator without real AI services.
"""

import asyncio
import logging
import random
from datetime import datetime
from typing import Any, Dict, List, Optional

from .base import AdapterConfig, AdapterResult, BaseAdapter

logger = logging.getLogger(__name__)


class MockAdapter(BaseAdapter):
    """
    Mock adapter for testing.

    Simulates agent behavior with configurable outcomes.
    Useful for testing orchestrator logic without real AI calls.
    """

    def __init__(
        self,
        config: Optional[AdapterConfig] = None,
        success_rate: float = 0.9,
        false_completion_rate: float = 0.1,
        execution_time_ms: int = 1000,
    ):
        super().__init__(config or AdapterConfig(
            name="mock",
            domain="default",
            provider="mock",
        ))
        self.success_rate = success_rate
        self.false_completion_rate = false_completion_rate
        self.execution_time_ms = execution_time_ms
        self._pending_results: Dict[str, asyncio.Future] = {}

    async def initialize(self) -> None:
        """Initialize mock adapter"""
        self._is_running = True
        logger.info("Mock adapter initialized")

    async def execute(
        self,
        task: "TaskState",
        prompt: str,
        context: Optional[Dict[str, Any]] = None,
    ) -> AdapterResult:
        """Execute with simulated behavior"""
        self._start_time = datetime.now()
        self._current_task = task

        # Simulate execution time
        await asyncio.sleep(self.execution_time_ms / 1000)

        # Determine outcome
        if random.random() > self.success_rate:
            # Simulate failure
            result = AdapterResult(
                success=False,
                error="Simulated failure",
            )
        else:
            # Simulate success
            # Sometimes simulate false completion (claims done but isn't)
            is_false_completion = random.random() < self.false_completion_rate

            if is_false_completion:
                # False completion: claims changes but didn't make them
                changes = [
                    {"file_path": "fake/path/that/doesnt/exist.ts", "action": "modified"},
                ]
                output = "Task completed successfully!\n\nModified: fake/path/that/doesnt/exist.ts"
            else:
                # Real completion
                changes = [
                    {"file_path": f"services/gateway/src/{task.domain.value}/mock_change.ts", "action": "modified"},
                ]
                output = f"Task completed successfully!\n\nModified: services/gateway/src/{task.domain.value}/mock_change.ts"

            result = AdapterResult(
                success=True,
                changes=changes,
                output=output,
                tokens_used=random.randint(100, 1000),
                cost_usd=random.uniform(0.001, 0.01),
                metadata={
                    "is_mock": True,
                    "is_false_completion": is_false_completion,
                },
            )

        # Store for wait_for_completion
        future = asyncio.get_event_loop().create_future()
        future.set_result(result.to_dict())
        self._pending_results[task.task_id] = future

        self._track_metrics(result)
        return result

    async def wait_for_completion(self, task: "TaskState") -> Dict[str, Any]:
        """Wait for mock completion"""
        future = self._pending_results.get(task.task_id)
        if future:
            result = await future
            del self._pending_results[task.task_id]
            return result

        # Execute if not already pending
        prompt = task.description or task.title
        result = await self.execute(task, prompt)
        return result.to_dict()

    async def cancel(self, task: "TaskState") -> bool:
        """Cancel mock task"""
        if task.task_id in self._pending_results:
            del self._pending_results[task.task_id]
            return True
        return False

    async def health_check(self) -> Dict[str, Any]:
        """Mock health check"""
        return {
            "status": "healthy",
            "provider": "mock",
            "success_rate": self.success_rate,
            "false_completion_rate": self.false_completion_rate,
        }


# Import for type hints
from ..main import TaskState  # noqa: E402
