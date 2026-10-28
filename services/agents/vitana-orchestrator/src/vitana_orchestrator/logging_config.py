"""
Logging Configuration

VTID: VTID-01175

Centralized logging setup for the orchestrator.
"""

import logging
import os
import sys
from datetime import datetime
from pathlib import Path
from typing import Optional


class VitanaFormatter(logging.Formatter):
    """Custom formatter with color support and structured output"""

    COLORS = {
        "DEBUG": "\033[36m",      # Cyan
        "INFO": "\033[32m",       # Green
        "WARNING": "\033[33m",    # Yellow
        "ERROR": "\033[31m",      # Red
        "CRITICAL": "\033[35m",   # Magenta
    }
    RESET = "\033[0m"

    def __init__(self, use_colors: bool = True):
        super().__init__()
        self.use_colors = use_colors and sys.stdout.isatty()

    def format(self, record: logging.LogRecord) -> str:
        # Build structured message
        timestamp = datetime.fromtimestamp(record.created).strftime("%H:%M:%S.%f")[:-3]
        level = record.levelname

        # Add color if enabled
        if self.use_colors:
            color = self.COLORS.get(level, "")
            level = f"{color}{level}{self.RESET}"

        # Format: [TIME] LEVEL [module] message
        parts = [
            f"[{timestamp}]",
            f"{level:8}",
            f"[{record.name}]",
            record.getMessage(),
        ]

        # Add exception info if present
        if record.exc_info:
            parts.append(self.formatException(record.exc_info))

        return " ".join(parts)


def setup_logging(
    level: str = "INFO",
    log_file: Optional[str] = None,
    use_colors: bool = True,
) -> None:
    """
    Configure logging for the orchestrator.

    Args:
        level: Log level (DEBUG, INFO, WARNING, ERROR)
        log_file: Optional file path for log output
        use_colors: Enable colored console output
    """
    # Get root logger for vitana_orchestrator
    root_logger = logging.getLogger("vitana_orchestrator")
    root_logger.setLevel(getattr(logging, level.upper(), logging.INFO))

    # Clear existing handlers
    root_logger.handlers.clear()

    # Console handler
    console_handler = logging.StreamHandler(sys.stdout)
    console_handler.setFormatter(VitanaFormatter(use_colors=use_colors))
    root_logger.addHandler(console_handler)

    # File handler (if specified)
    if log_file:
        log_path = Path(log_file)
        log_path.parent.mkdir(parents=True, exist_ok=True)

        file_handler = logging.FileHandler(log_path)
        file_handler.setFormatter(VitanaFormatter(use_colors=False))
        root_logger.addHandler(file_handler)

    # Set level for third-party loggers
    logging.getLogger("httpx").setLevel(logging.WARNING)
    logging.getLogger("httpcore").setLevel(logging.WARNING)
    logging.getLogger("anthropic").setLevel(logging.WARNING)

    root_logger.debug("Logging configured")


def get_logger(name: str) -> logging.Logger:
    """Get a logger instance"""
    return logging.getLogger(f"vitana_orchestrator.{name}")
