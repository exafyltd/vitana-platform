"""
Vitana Orchestrator - VTID-01175

Production-grade orchestrator for managing sub-agents with guaranteed task completion.
Implements verification loops to prevent false confirmations and ensure delivery.
"""

__version__ = "1.0.0"
__vtid__ = "VTID-01175"

from .main import OrchestratorConfig, TaskConfig, TaskStatus, TaskState
from .orchestrator import VitanaOrchestrator

__all__ = [
    "VitanaOrchestrator",
    "OrchestratorConfig",
    "TaskConfig",
    "TaskStatus",
    "TaskState",
    "__version__",
    "__vtid__",
]
