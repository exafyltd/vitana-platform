"""
VTID-01208: Shared utilities for Vitana agent services

This module provides shared utilities that can be used across all Python-based
agent services (conductor, validator-core, memory-indexer, etc.)

Exports:
- LLMTelemetry: Telemetry service for LLM calls
- LLMStage: Enum for LLM execution stages
- LLMProvider: Enum for LLM providers
- get_telemetry: Get singleton telemetry instance
- with_telemetry: Context manager for LLM calls with telemetry
"""

from .llm_telemetry import (
    LLMTelemetry,
    LLMStage,
    LLMProvider,
    LLMCallContext,
    get_telemetry,
    with_telemetry,
    hash_prompt,
    estimate_cost,
    MODEL_COSTS,
)

__all__ = [
    "LLMTelemetry",
    "LLMStage",
    "LLMProvider",
    "LLMCallContext",
    "get_telemetry",
    "with_telemetry",
    "hash_prompt",
    "estimate_cost",
    "MODEL_COSTS",
]
