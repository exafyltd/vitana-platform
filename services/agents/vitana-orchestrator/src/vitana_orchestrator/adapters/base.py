"""
Base Adapter Interface

VTID: VTID-01175

All sub-agent adapters must implement this interface.
"""

import asyncio
import logging
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)


@dataclass
class AdapterConfig:
    """Configuration for an adapter"""
    name: str
    domain: str
    timeout_ms: int = 1800000  # 30 minutes
    max_retries: int = 3
    provider: str = "claude"
    model: str = "claude-3-5-sonnet-20241022"
    temperature: float = 0.7
    max_tokens: int = 4096
    metadata: Dict[str, Any] = field(default_factory=dict)


@dataclass
class AdapterResult:
    """Result from an adapter execution"""
    success: bool
    changes: List[Dict[str, Any]] = field(default_factory=list)
    artifacts: List[str] = field(default_factory=list)
    output: str = ""
    error: Optional[str] = None
    duration_ms: int = 0
    tokens_used: int = 0
    cost_usd: float = 0.0
    metadata: Dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary"""
        return {
            "success": self.success,
            "changes": self.changes,
            "artifacts": self.artifacts,
            "output": self.output,
            "error": self.error,
            "duration_ms": self.duration_ms,
            "tokens_used": self.tokens_used,
            "cost_usd": self.cost_usd,
            "metadata": self.metadata,
        }


class BaseAdapter(ABC):
    """
    Base class for all sub-agent adapters.

    Each adapter connects to a specific AI agent implementation
    (Claude, CrewAI, Gemini, etc.) and provides a unified interface.
    """

    def __init__(self, config: Optional[AdapterConfig] = None):
        self.config = config or AdapterConfig(name="base", domain="default")
        self._is_running = False
        self._current_task = None
        self._start_time: Optional[datetime] = None

    @property
    def name(self) -> str:
        return self.config.name

    @property
    def domain(self) -> str:
        return self.config.domain

    @abstractmethod
    async def initialize(self) -> None:
        """Initialize the adapter (connect to services, load models, etc.)"""
        pass

    @abstractmethod
    async def execute(
        self,
        task: "TaskState",
        prompt: str,
        context: Optional[Dict[str, Any]] = None,
    ) -> AdapterResult:
        """
        Execute a task.

        Args:
            task: The task state object
            prompt: The prompt/instruction for the agent
            context: Additional context (files, memory, etc.)

        Returns:
            AdapterResult with the execution outcome
        """
        pass

    @abstractmethod
    async def wait_for_completion(self, task: "TaskState") -> Dict[str, Any]:
        """
        Wait for a task to complete.

        This is called after execute() to wait for the agent to finish.
        Returns the claimed result from the agent.
        """
        pass

    @abstractmethod
    async def cancel(self, task: "TaskState") -> bool:
        """
        Cancel a running task.

        Returns True if cancellation was successful.
        """
        pass

    @abstractmethod
    async def health_check(self) -> Dict[str, Any]:
        """Check adapter health and connectivity"""
        pass

    async def shutdown(self) -> None:
        """Clean up resources"""
        self._is_running = False
        logger.info(f"Adapter {self.name} shut down")

    # =========================================================================
    # Helper Methods
    # =========================================================================

    def _build_prompt(
        self,
        task: "TaskState",
        base_prompt: str,
        context: Optional[Dict[str, Any]] = None,
    ) -> str:
        """Build the full prompt with context"""
        parts = []

        # System context
        parts.append(f"# Task: {task.title}")
        parts.append(f"VTID: {task.vtid}")
        parts.append(f"Domain: {task.domain.value}")

        # Target paths
        if task.target_paths:
            parts.append(f"\nTarget Paths:\n" + "\n".join(f"- {p}" for p in task.target_paths))

        # Additional context
        if context:
            if "memory" in context:
                parts.append(f"\n## Relevant Memory:\n{context['memory']}")
            if "files" in context:
                parts.append(f"\n## Relevant Files:\n{context['files']}")

        # Main instruction
        parts.append(f"\n## Instructions:\n{base_prompt}")

        # Task description
        if task.description:
            parts.append(f"\n## Details:\n{task.description}")

        return "\n".join(parts)

    def _extract_changes(self, output: str) -> List[Dict[str, Any]]:
        """Extract file changes from agent output"""
        changes = []

        # Look for common patterns indicating file changes
        lines = output.split("\n")
        current_file = None

        for line in lines:
            # Check for file markers
            if line.startswith("File:") or line.startswith("Modified:") or line.startswith("Created:"):
                current_file = line.split(":", 1)[1].strip()
                changes.append({
                    "file_path": current_file,
                    "action": "modified" if "Modified" in line else "created",
                })
            elif line.startswith("Deleted:"):
                changes.append({
                    "file_path": line.split(":", 1)[1].strip(),
                    "action": "deleted",
                })

        return changes

    def _track_metrics(self, result: AdapterResult) -> None:
        """Track execution metrics"""
        if self._start_time:
            delta = datetime.now() - self._start_time
            result.duration_ms = int(delta.total_seconds() * 1000)


# Import TaskState for type hints
from ..main import TaskState  # noqa: E402
