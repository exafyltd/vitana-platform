"""
Sub-Agent Adapters

Adapters for connecting to different AI agent implementations.
"""

from .base import BaseAdapter, AdapterConfig, AdapterResult
from .claude import ClaudeAdapter
from .crewai import CrewAIAdapter
from .mock import MockAdapter

__all__ = [
    "BaseAdapter",
    "AdapterConfig",
    "AdapterResult",
    "ClaudeAdapter",
    "CrewAIAdapter",
    "MockAdapter",
]
