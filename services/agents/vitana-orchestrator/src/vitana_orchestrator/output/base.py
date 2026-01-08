"""
Base Output Formatter

VTID: VTID-01175
"""

from abc import ABC, abstractmethod
from enum import Enum
from typing import Any, Dict, Optional

from ..main import TaskState


class OutputLevel(Enum):
    """Output verbosity levels"""
    QUIET = 0
    NORMAL = 1
    VERBOSE = 2
    DEBUG = 3


class BaseFormatter(ABC):
    """Base class for output formatters"""

    def __init__(self, level: OutputLevel = OutputLevel.NORMAL):
        self.level = level

    @abstractmethod
    def task_started(self, task: TaskState) -> None:
        """Format task started message"""
        pass

    @abstractmethod
    def task_progress(self, task: TaskState, message: str) -> None:
        """Format task progress message"""
        pass

    @abstractmethod
    def task_completed(self, task: TaskState) -> None:
        """Format task completed message"""
        pass

    @abstractmethod
    def task_failed(self, task: TaskState, error: str) -> None:
        """Format task failed message"""
        pass

    @abstractmethod
    def verification_result(
        self,
        task: TaskState,
        passed: bool,
        details: Optional[Dict[str, Any]] = None,
    ) -> None:
        """Format verification result"""
        pass

    @abstractmethod
    def summary(self, stats: Dict[str, Any]) -> None:
        """Format summary statistics"""
        pass
