"""
Claude Agent SDK Adapter

VTID: VTID-01175

Adapter for integrating with Claude via the Anthropic API.
"""

import asyncio
import logging
import os
from datetime import datetime
from typing import Any, Dict, List, Optional

from .base import AdapterConfig, AdapterResult, BaseAdapter

logger = logging.getLogger(__name__)


class ClaudeAdapter(BaseAdapter):
    """
    Adapter for Claude AI agents.

    Uses the Anthropic API to execute tasks with Claude models.
    Supports streaming, tool use, and conversation management.
    """

    def __init__(self, config: Optional[AdapterConfig] = None):
        super().__init__(config or AdapterConfig(
            name="claude",
            domain="default",
            provider="anthropic",
            model="claude-3-5-sonnet-20241022",
        ))
        self._client = None
        self._conversation_id: Optional[str] = None
        self._pending_results: Dict[str, asyncio.Future] = {}

    async def initialize(self) -> None:
        """Initialize the Claude client"""
        try:
            from anthropic import AsyncAnthropic
        except ImportError:
            raise ImportError("anthropic package is required for ClaudeAdapter")

        api_key = os.getenv("ANTHROPIC_API_KEY")
        if not api_key:
            raise ValueError("ANTHROPIC_API_KEY environment variable is required")

        self._client = AsyncAnthropic(api_key=api_key)
        self._is_running = True
        logger.info(f"Claude adapter initialized with model: {self.config.model}")

    async def execute(
        self,
        task: "TaskState",
        prompt: str,
        context: Optional[Dict[str, Any]] = None,
    ) -> AdapterResult:
        """Execute a task using Claude"""
        if not self._client:
            await self.initialize()

        self._start_time = datetime.now()
        self._current_task = task

        # Build the full prompt
        full_prompt = self._build_prompt(task, prompt, context)

        # Create system message based on domain
        system_message = self._get_system_message(task.domain)

        try:
            # Call Claude API
            response = await self._client.messages.create(
                model=self.config.model,
                max_tokens=self.config.max_tokens,
                temperature=self.config.temperature,
                system=system_message,
                messages=[{"role": "user", "content": full_prompt}],
            )

            # Extract response
            output = response.content[0].text if response.content else ""
            changes = self._extract_changes(output)

            # Calculate cost
            input_tokens = response.usage.input_tokens
            output_tokens = response.usage.output_tokens
            cost = self._calculate_cost(input_tokens, output_tokens)

            result = AdapterResult(
                success=True,
                changes=changes,
                output=output,
                tokens_used=input_tokens + output_tokens,
                cost_usd=cost,
                metadata={
                    "model": self.config.model,
                    "input_tokens": input_tokens,
                    "output_tokens": output_tokens,
                    "stop_reason": response.stop_reason,
                },
            )

            # Store result for wait_for_completion
            future = asyncio.get_event_loop().create_future()
            future.set_result(result.to_dict())
            self._pending_results[task.task_id] = future

            self._track_metrics(result)
            return result

        except Exception as e:
            logger.error(f"Claude execution error: {e}")
            result = AdapterResult(
                success=False,
                error=str(e),
            )
            self._track_metrics(result)
            return result

    async def wait_for_completion(self, task: "TaskState") -> Dict[str, Any]:
        """Wait for task completion"""
        future = self._pending_results.get(task.task_id)
        if future:
            result = await future
            del self._pending_results[task.task_id]
            return result

        # If no pending result, execute the task
        prompt = task.description or task.title
        result = await self.execute(task, prompt)
        return result.to_dict()

    async def cancel(self, task: "TaskState") -> bool:
        """Cancel a running task"""
        if task.task_id in self._pending_results:
            future = self._pending_results[task.task_id]
            if not future.done():
                future.cancel()
            del self._pending_results[task.task_id]
            return True
        return False

    async def health_check(self) -> Dict[str, Any]:
        """Check Claude API health"""
        try:
            if not self._client:
                await self.initialize()

            # Simple test call
            response = await self._client.messages.create(
                model=self.config.model,
                max_tokens=10,
                messages=[{"role": "user", "content": "ping"}],
            )

            return {
                "status": "healthy",
                "provider": "anthropic",
                "model": self.config.model,
                "latency_ms": 0,  # Would measure actual latency
            }
        except Exception as e:
            return {
                "status": "unhealthy",
                "provider": "anthropic",
                "error": str(e),
            }

    def _get_system_message(self, domain: "TaskDomain") -> str:
        """Get domain-specific system message"""
        from ..main import TaskDomain

        base_system = """You are a specialized AI worker agent for the Vitana platform.
Your task is to implement changes accurately and completely.

CRITICAL RULES:
1. Make ONLY the changes requested - no extra features or improvements
2. Follow existing code patterns and conventions
3. Report ALL files you modify or create
4. If you cannot complete a task, explain why clearly
5. Do not claim completion unless the work is truly done

Output Format:
- Start with a brief summary of what you will do
- List each file change with "File: <path>" or "Modified: <path>"
- End with a completion status"""

        domain_additions = {
            TaskDomain.FRONTEND: """

Frontend-specific:
- Follow accessibility guidelines (WCAG 2.1)
- Use existing component patterns
- Ensure responsive design
- Test UI changes visually""",
            TaskDomain.BACKEND: """

Backend-specific:
- Follow REST API conventions
- Add proper error handling
- Include input validation
- Consider security implications""",
            TaskDomain.MEMORY: """

Memory/Database-specific:
- Always include RLS policies for new tables
- Preview migration changes before applying
- Consider data integrity
- Document schema changes""",
        }

        return base_system + domain_additions.get(domain, "")

    def _calculate_cost(self, input_tokens: int, output_tokens: int) -> float:
        """Calculate API cost"""
        # Claude 3.5 Sonnet pricing
        input_cost = input_tokens * 3.0 / 1_000_000
        output_cost = output_tokens * 15.0 / 1_000_000
        return round(input_cost + output_cost, 6)


# Import for type hints
from ..main import TaskDomain, TaskState  # noqa: E402
