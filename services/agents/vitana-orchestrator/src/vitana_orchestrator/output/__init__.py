"""
Output Formatting

Provides formatted output for console and structured reporting.
"""

from .base import BaseFormatter, OutputLevel
from .console import ConsoleFormatter

__all__ = [
    "BaseFormatter",
    "OutputLevel",
    "ConsoleFormatter",
]
