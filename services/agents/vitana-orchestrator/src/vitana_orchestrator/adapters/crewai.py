"""
CrewAI Adapter

VTID: VTID-01175

Adapter for integrating with CrewAI-based agents.
"""

import asyncio
import logging
import os
from datetime import datetime
from typing import Any, Dict, List, Optional

from .base import AdapterConfig, AdapterResult, BaseAdapter

logger = logging.getLogger(__name__)


class CrewAIAdapter(BaseAdapter):
    """
    Adapter for CrewAI-based agents.

    Connects to the CrewAI service running in the platform
    for crew-based task execution.
    """

    def __init__(self, config: Optional[AdapterConfig] = None):
        super().__init__(config or AdapterConfig(
            name="crewai",
            domain="default",
            provider="crewai",
        ))
        self._service_url: Optional[str] = None
        self._pending_jobs: Dict[str, str] = {}  # task_id -> job_id

    async def initialize(self) -> None:
        """Initialize the CrewAI connection"""
        self._service_url = os.getenv(
            "CREWAI_SERVICE_URL",
            "http://localhost:8082"
        )
        self._is_running = True
        logger.info(f"CrewAI adapter initialized with service: {self._service_url}")

    async def execute(
        self,
        task: "TaskState",
        prompt: str,
        context: Optional[Dict[str, Any]] = None,
    ) -> AdapterResult:
        """Execute a task using CrewAI"""
        import httpx

        if not self._service_url:
            await self.initialize()

        self._start_time = datetime.now()
        self._current_task = task

        # Build the crew payload
        payload = self._build_crew_payload(task, prompt, context)

        try:
            async with httpx.AsyncClient(timeout=30.0) as client:
                # Submit job to CrewAI service
                response = await client.post(
                    f"{self._service_url}/execute",
                    json=payload,
                )
                response.raise_for_status()

                job_data = response.json()
                job_id = job_data.get("job_id")

                if job_id:
                    self._pending_jobs[task.task_id] = job_id

                # For sync execution, wait for result
                if job_data.get("status") == "completed":
                    return self._parse_crew_result(job_data)

                return AdapterResult(
                    success=True,
                    metadata={
                        "job_id": job_id,
                        "status": "pending",
                    },
                )

        except Exception as e:
            logger.error(f"CrewAI execution error: {e}")
            return AdapterResult(
                success=False,
                error=str(e),
            )

    async def wait_for_completion(self, task: "TaskState") -> Dict[str, Any]:
        """Wait for CrewAI job completion"""
        import httpx

        job_id = self._pending_jobs.get(task.task_id)
        if not job_id:
            return {"success": False, "error": "No pending job found"}

        timeout_seconds = self.config.timeout_ms / 1000
        poll_interval = 5  # seconds
        elapsed = 0

        try:
            async with httpx.AsyncClient() as client:
                while elapsed < timeout_seconds:
                    response = await client.get(
                        f"{self._service_url}/jobs/{job_id}"
                    )
                    response.raise_for_status()

                    job_data = response.json()
                    status = job_data.get("status")

                    if status == "completed":
                        del self._pending_jobs[task.task_id]
                        result = self._parse_crew_result(job_data)
                        return result.to_dict()

                    if status == "failed":
                        del self._pending_jobs[task.task_id]
                        return {
                            "success": False,
                            "error": job_data.get("error", "Job failed"),
                        }

                    await asyncio.sleep(poll_interval)
                    elapsed += poll_interval

            # Timeout
            return {"success": False, "error": "Job timed out"}

        except Exception as e:
            logger.error(f"Error waiting for CrewAI job: {e}")
            return {"success": False, "error": str(e)}

    async def cancel(self, task: "TaskState") -> bool:
        """Cancel a CrewAI job"""
        import httpx

        job_id = self._pending_jobs.get(task.task_id)
        if not job_id:
            return False

        try:
            async with httpx.AsyncClient() as client:
                response = await client.delete(
                    f"{self._service_url}/jobs/{job_id}"
                )
                if response.status_code == 200:
                    del self._pending_jobs[task.task_id]
                    return True
        except Exception as e:
            logger.error(f"Error cancelling CrewAI job: {e}")

        return False

    async def health_check(self) -> Dict[str, Any]:
        """Check CrewAI service health"""
        import httpx

        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                response = await client.get(f"{self._service_url}/health")
                health_data = response.json()

                return {
                    "status": "healthy" if health_data.get("status") == "ok" else "unhealthy",
                    "provider": "crewai",
                    "service_url": self._service_url,
                    "service_status": health_data,
                }
        except Exception as e:
            return {
                "status": "unhealthy",
                "provider": "crewai",
                "error": str(e),
            }

    def _build_crew_payload(
        self,
        task: "TaskState",
        prompt: str,
        context: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """Build payload for CrewAI service"""
        return {
            "vtid": task.vtid,
            "task_id": task.task_id,
            "title": task.title,
            "description": task.description,
            "domain": task.domain.value,
            "prompt": prompt,
            "target_paths": task.target_paths,
            "context": context or {},
            "config": {
                "timeout_ms": self.config.timeout_ms,
                "max_retries": self.config.max_retries,
            },
        }

    def _parse_crew_result(self, job_data: Dict[str, Any]) -> AdapterResult:
        """Parse CrewAI job result into AdapterResult"""
        output = job_data.get("output", "")
        changes = job_data.get("changes", [])

        return AdapterResult(
            success=True,
            changes=changes,
            output=output,
            artifacts=job_data.get("artifacts", []),
            metadata={
                "job_id": job_data.get("job_id"),
                "crew_name": job_data.get("crew_name"),
                "agents_used": job_data.get("agents_used", []),
            },
        )


# Import for type hints
from ..main import TaskState  # noqa: E402
