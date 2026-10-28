"""
VTID-01208: LLM Telemetry Module for Python Services

Provides telemetry emission for all LLM calls across Python agent services.
Emits llm.call.started/completed/failed events to OASIS.

Usage:
    from shared.llm_telemetry import LLMTelemetry, LLMStage

    telemetry = LLMTelemetry(
        service="conductor",
        oasis_url=os.getenv("OASIS_GATEWAY_URL")
    )

    # Start a call
    context = telemetry.start_call(
        vtid="VTID-01234",
        stage=LLMStage.PLANNER,
        provider="anthropic",
        model="claude-3-5-sonnet-20241022",
        prompt=prompt
    )

    try:
        result = call_llm(prompt)
        telemetry.complete_call(
            context,
            input_tokens=result.usage.input_tokens,
            output_tokens=result.usage.output_tokens
        )
    except Exception as e:
        telemetry.fail_call(context, error=str(e))
        raise
"""

import os
import time
import uuid
import hashlib
import json
from typing import Optional, Dict, Any
from enum import Enum
from dataclasses import dataclass, field
import requests


class LLMStage(Enum):
    """LLM execution stages"""
    PLANNER = "planner"
    WORKER = "worker"
    VALIDATOR = "validator"
    OPERATOR = "operator"
    MEMORY = "memory"


class LLMProvider(Enum):
    """Supported LLM providers"""
    ANTHROPIC = "anthropic"
    VERTEX = "vertex"
    OPENAI = "openai"


@dataclass
class LLMCallContext:
    """Context for tracking an LLM call lifecycle"""
    trace_id: str
    vtid: Optional[str]
    thread_id: Optional[str]
    service: str
    stage: LLMStage
    domain: Optional[str]
    provider: str
    model: str
    prompt_hash: str
    agent_config_version: Optional[str]
    start_time: float

    def to_dict(self) -> Dict[str, Any]:
        return {
            "trace_id": self.trace_id,
            "vtid": self.vtid,
            "thread_id": self.thread_id,
            "service": self.service,
            "stage": self.stage.value,
            "domain": self.domain,
            "provider": self.provider,
            "model": self.model,
            "prompt_hash": self.prompt_hash,
            "agent_config_version": self.agent_config_version,
        }


# Model cost information (USD per 1M tokens)
MODEL_COSTS = {
    # Anthropic
    "claude-3-5-sonnet-20241022": {"input": 3.00, "output": 15.00},
    "claude-3-opus-20240229": {"input": 15.00, "output": 75.00},
    "claude-3-haiku-20240307": {"input": 0.25, "output": 1.25},
    # Google Vertex AI
    "gemini-2.5-pro": {"input": 1.25, "output": 5.00},
    "gemini-1.5-pro": {"input": 1.25, "output": 5.00},
    "gemini-1.5-flash": {"input": 0.075, "output": 0.30},
    # OpenAI (future support)
    "gpt-4o": {"input": 5.00, "output": 15.00},
    "gpt-4o-mini": {"input": 0.15, "output": 0.60},
}


def hash_prompt(prompt: str) -> str:
    """Hash a prompt for audit purposes (no raw prompts stored)"""
    return hashlib.sha256(prompt.encode()).hexdigest()[:16]


def estimate_cost(model: str, input_tokens: int, output_tokens: int) -> float:
    """Calculate estimated cost for an LLM call"""
    costs = MODEL_COSTS.get(model)
    if not costs:
        return 0.0

    input_cost = (input_tokens / 1_000_000) * costs["input"]
    output_cost = (output_tokens / 1_000_000) * costs["output"]

    return round(input_cost + output_cost, 6)


class LLMTelemetry:
    """
    LLM Telemetry service for emitting call events to OASIS.

    Thread-safe and designed for concurrent use.
    """

    def __init__(
        self,
        service: str,
        oasis_url: Optional[str] = None,
        supabase_url: Optional[str] = None,
        supabase_key: Optional[str] = None
    ):
        """
        Initialize telemetry service.

        Args:
            service: Service name (e.g., "conductor", "validator-core")
            oasis_url: OASIS Gateway URL for event ingestion
            supabase_url: Supabase URL (alternative to OASIS)
            supabase_key: Supabase service role key
        """
        self.service = service
        self.oasis_url = oasis_url or os.getenv("OASIS_GATEWAY_URL")
        self.supabase_url = supabase_url or os.getenv("SUPABASE_URL")
        self.supabase_key = supabase_key or os.getenv("SUPABASE_SERVICE_ROLE")

    def start_call(
        self,
        vtid: Optional[str],
        stage: LLMStage,
        provider: str,
        model: str,
        prompt: str,
        thread_id: Optional[str] = None,
        domain: Optional[str] = None,
        agent_config_version: Optional[str] = None
    ) -> LLMCallContext:
        """
        Start tracking an LLM call. Emits llm.call.started event.

        Args:
            vtid: VTID for the task (nullable for Operator free chat)
            stage: LLM stage (planner, worker, validator, operator, memory)
            provider: LLM provider (anthropic, vertex, openai)
            model: Model ID
            prompt: The prompt (will be hashed, not stored)
            thread_id: Optional thread ID for conversations
            domain: Optional worker domain (frontend, backend, memory, mixed)
            agent_config_version: Optional hash of agent config

        Returns:
            LLMCallContext for tracking the call lifecycle
        """
        trace_id = str(uuid.uuid4())
        prompt_hash = hash_prompt(prompt)
        start_time = time.time()

        context = LLMCallContext(
            trace_id=trace_id,
            vtid=vtid,
            thread_id=thread_id,
            service=self.service,
            stage=stage,
            domain=domain,
            provider=provider,
            model=model,
            prompt_hash=prompt_hash,
            agent_config_version=agent_config_version,
            start_time=start_time
        )

        # Emit started event
        self._emit_event(
            vtid=vtid or "VTID-01208",
            event_type="llm.call.started",
            status="info",
            message=f"LLM call started: {stage.value} using {provider}/{model}",
            payload={
                **context.to_dict(),
                "fallback_used": False,
                "latency_ms": 0,
                "created_at": self._timestamp(),
            }
        )

        return context

    def complete_call(
        self,
        context: LLMCallContext,
        input_tokens: Optional[int] = None,
        output_tokens: Optional[int] = None,
        request_id: Optional[str] = None,
        fallback_used: bool = False,
        fallback_from: Optional[str] = None,
        fallback_to: Optional[str] = None,
        retry_count: int = 0
    ) -> Dict[str, Any]:
        """
        Complete tracking an LLM call. Emits llm.call.completed event.

        Args:
            context: The context from start_call
            input_tokens: Number of input tokens used
            output_tokens: Number of output tokens generated
            request_id: Provider's request ID (if available)
            fallback_used: Whether fallback model was used
            fallback_from: Original model (if fallback)
            fallback_to: Fallback model used (if fallback)
            retry_count: Number of retries attempted

        Returns:
            Telemetry payload dictionary
        """
        latency_ms = int((time.time() - context.start_time) * 1000)

        # Calculate cost
        model_for_cost = fallback_to if fallback_used else context.model
        cost_estimate = estimate_cost(
            model_for_cost,
            input_tokens or 0,
            output_tokens or 0
        ) if input_tokens and output_tokens else None

        payload = {
            **context.to_dict(),
            "fallback_used": fallback_used,
            "fallback_from": fallback_from,
            "fallback_to": fallback_to,
            "retry_count": retry_count,
            "request_id": request_id,
            "latency_ms": latency_ms,
            "input_tokens": input_tokens,
            "output_tokens": output_tokens,
            "cost_estimate_usd": cost_estimate,
            "created_at": self._timestamp(),
        }

        self._emit_event(
            vtid=context.vtid or "VTID-01208",
            event_type="llm.call.completed",
            status="success",
            message=f"LLM call completed: {context.stage.value} in {latency_ms}ms" + (" (fallback)" if fallback_used else ""),
            payload=payload
        )

        return payload

    def fail_call(
        self,
        context: LLMCallContext,
        error: str,
        error_code: Optional[str] = None,
        fallback_used: bool = False,
        fallback_from: Optional[str] = None,
        fallback_to: Optional[str] = None,
        retry_count: int = 0
    ) -> Dict[str, Any]:
        """
        Record a failed LLM call. Emits llm.call.failed event.

        Args:
            context: The context from start_call
            error: Error message
            error_code: Error code (if available)
            fallback_used: Whether fallback was attempted
            fallback_from: Original model
            fallback_to: Fallback model attempted
            retry_count: Number of retries attempted

        Returns:
            Telemetry payload dictionary
        """
        latency_ms = int((time.time() - context.start_time) * 1000)

        payload = {
            **context.to_dict(),
            "fallback_used": fallback_used,
            "fallback_from": fallback_from,
            "fallback_to": fallback_to,
            "retry_count": retry_count,
            "latency_ms": latency_ms,
            "error_code": error_code,
            "error_message": error,
            "created_at": self._timestamp(),
        }

        self._emit_event(
            vtid=context.vtid or "VTID-01208",
            event_type="llm.call.failed",
            status="error",
            message=f"LLM call failed: {context.stage.value} - {error}",
            payload=payload
        )

        return payload

    def _emit_event(
        self,
        vtid: str,
        event_type: str,
        status: str,
        message: str,
        payload: Dict[str, Any]
    ) -> Optional[str]:
        """
        Emit an event to OASIS (via Supabase or direct endpoint).

        Returns event ID if successful, None otherwise.
        """
        event_id = str(uuid.uuid4())

        event_data = {
            "id": event_id,
            "created_at": self._timestamp(),
            "vtid": vtid,
            "topic": event_type,
            "service": self.service,
            "role": "AGENT",
            "model": "llm-telemetry",
            "status": status,
            "message": message,
            "metadata": payload
        }

        # Try Supabase first (direct insert)
        if self.supabase_url and self.supabase_key:
            try:
                response = requests.post(
                    f"{self.supabase_url}/rest/v1/oasis_events",
                    json=event_data,
                    headers={
                        "Content-Type": "application/json",
                        "apikey": self.supabase_key,
                        "Authorization": f"Bearer {self.supabase_key}",
                        "Prefer": "return=minimal"
                    },
                    timeout=5
                )
                if response.ok:
                    print(f"[LLM Telemetry] Event emitted: {event_type} ({event_id[:8]})")
                    return event_id
                else:
                    print(f"[LLM Telemetry] Supabase emit failed: {response.status_code}")
            except Exception as e:
                print(f"[LLM Telemetry] Supabase error: {e}")

        # Fallback to OASIS Gateway
        if self.oasis_url:
            try:
                # Transform to gateway format
                gateway_event = {
                    "vtid": vtid,
                    "type": event_type,
                    "source": self.service,
                    "status": status,
                    "message": message,
                    "payload": payload
                }

                response = requests.post(
                    f"{self.oasis_url}/api/v1/events/ingest",
                    json=gateway_event,
                    timeout=5
                )
                if response.ok:
                    print(f"[LLM Telemetry] Event emitted via gateway: {event_type}")
                    return event_id
                else:
                    print(f"[LLM Telemetry] Gateway emit failed: {response.status_code}")
            except Exception as e:
                print(f"[LLM Telemetry] Gateway error: {e}")

        print(f"[LLM Telemetry] Warning: Could not emit event {event_type}")
        return None

    def _timestamp(self) -> str:
        """Get current ISO timestamp"""
        from datetime import datetime, timezone
        return datetime.now(timezone.utc).isoformat()


# Singleton instance for convenience
_telemetry_instance: Optional[LLMTelemetry] = None


def get_telemetry(service: str) -> LLMTelemetry:
    """
    Get or create a telemetry instance for a service.

    Args:
        service: Service name

    Returns:
        LLMTelemetry instance
    """
    global _telemetry_instance
    if _telemetry_instance is None or _telemetry_instance.service != service:
        _telemetry_instance = LLMTelemetry(service=service)
    return _telemetry_instance


# Convenience wrapper function
def with_telemetry(
    vtid: Optional[str],
    stage: LLMStage,
    provider: str,
    model: str,
    prompt: str,
    service: str = "unknown",
    **kwargs
):
    """
    Decorator/context manager for LLM calls with automatic telemetry.

    Usage as context manager:
        with with_telemetry(vtid, LLMStage.PLANNER, "anthropic", "claude-3.5-sonnet", prompt, "conductor") as ctx:
            result = call_llm(prompt)
            ctx.complete(input_tokens=result.usage.input_tokens, output_tokens=result.usage.output_tokens)
    """
    telemetry = get_telemetry(service)
    context = telemetry.start_call(
        vtid=vtid,
        stage=stage,
        provider=provider,
        model=model,
        prompt=prompt,
        **kwargs
    )

    class TelemetryContext:
        def __init__(self, ctx, tel):
            self._context = ctx
            self._telemetry = tel
            self._completed = False

        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc_val, exc_tb):
            if exc_type and not self._completed:
                self._telemetry.fail_call(
                    self._context,
                    error=str(exc_val) if exc_val else "Unknown error"
                )
            return False

        def complete(self, **kwargs):
            self._completed = True
            return self._telemetry.complete_call(self._context, **kwargs)

        def fail(self, error: str, **kwargs):
            self._completed = True
            return self._telemetry.fail_call(self._context, error=error, **kwargs)

    return TelemetryContext(context, telemetry)
