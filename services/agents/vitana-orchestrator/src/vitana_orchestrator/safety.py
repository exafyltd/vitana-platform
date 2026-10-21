"""
Safety Checks

VTID: VTID-01175

Safety validation to prevent dangerous operations.
"""

import logging
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional, Set

from .main import TaskConfig, TaskDomain, TaskState

logger = logging.getLogger(__name__)


@dataclass
class SafetyCheckResult:
    """Result of a safety check"""
    safe: bool
    reason: str = ""
    blocked_items: List[str] = None

    def __post_init__(self):
        if self.blocked_items is None:
            self.blocked_items = []


class SafetyChecker:
    """
    Validates tasks for safety before execution.

    Prevents:
    - Access to sensitive files
    - Dangerous commands
    - Scope creep beyond allowed paths
    - Unsafe operations in production
    """

    # Paths that should never be modified
    FORBIDDEN_PATHS: Set[str] = {
        ".git",
        ".env",
        ".env.local",
        ".env.production",
        "credentials.json",
        "serviceAccountKey.json",
        "secrets/",
        "node_modules/",
        "__pycache__/",
    }

    # Patterns for sensitive content
    SENSITIVE_PATTERNS: List[str] = [
        r"ANTHROPIC_API_KEY",
        r"GOOGLE_APPLICATION_CREDENTIALS",
        r"AWS_SECRET_ACCESS_KEY",
        r"DATABASE_URL",
        r"JWT_SECRET",
        r"PRIVATE_KEY",
    ]

    # Maximum scope limits
    MAX_FILES_DEFAULT = 20
    MAX_DIRECTORIES_DEFAULT = 10

    def __init__(
        self,
        forbidden_paths: Optional[Set[str]] = None,
        max_files: int = MAX_FILES_DEFAULT,
        max_directories: int = MAX_DIRECTORIES_DEFAULT,
    ):
        self.forbidden_paths = forbidden_paths or self.FORBIDDEN_PATHS
        self.max_files = max_files
        self.max_directories = max_directories

    def check_task(self, task: TaskConfig) -> SafetyCheckResult:
        """Run all safety checks on a task"""
        # Check forbidden paths
        path_result = self._check_paths(task.target_paths)
        if not path_result.safe:
            return path_result

        # Check scope limits
        scope_result = self._check_scope(task)
        if not scope_result.safe:
            return scope_result

        return SafetyCheckResult(safe=True, reason="All safety checks passed")

    def check_changes(self, changes: List[Dict[str, Any]]) -> SafetyCheckResult:
        """Check proposed changes for safety"""
        blocked = []

        for change in changes:
            file_path = change.get("file_path", "")

            # Check forbidden paths
            if self._is_forbidden_path(file_path):
                blocked.append(file_path)

            # Check for sensitive content in new files
            content = change.get("content", "")
            if content and self._contains_sensitive_content(content):
                blocked.append(f"{file_path} (contains sensitive data)")

        if blocked:
            return SafetyCheckResult(
                safe=False,
                reason="Changes contain forbidden paths or sensitive data",
                blocked_items=blocked,
            )

        return SafetyCheckResult(safe=True, reason="Changes are safe")

    def check_output(self, output: str) -> SafetyCheckResult:
        """Check agent output for leaked secrets"""
        leaked = []

        for pattern in self.SENSITIVE_PATTERNS:
            if re.search(pattern, output, re.IGNORECASE):
                leaked.append(pattern)

        # Check for actual secret values (basic pattern)
        secret_value_pattern = r'["\']([a-zA-Z0-9_-]{32,})["\']'
        matches = re.findall(secret_value_pattern, output)
        if matches:
            leaked.extend(["potential_secret_value"] * len(matches))

        if leaked:
            return SafetyCheckResult(
                safe=False,
                reason="Output may contain leaked secrets",
                blocked_items=leaked,
            )

        return SafetyCheckResult(safe=True, reason="Output is safe")

    def _check_paths(self, paths: List[str]) -> SafetyCheckResult:
        """Check paths for forbidden locations"""
        blocked = []

        for path in paths:
            if self._is_forbidden_path(path):
                blocked.append(path)

        if blocked:
            return SafetyCheckResult(
                safe=False,
                reason="Task targets forbidden paths",
                blocked_items=blocked,
            )

        return SafetyCheckResult(safe=True)

    def _check_scope(self, task: TaskConfig) -> SafetyCheckResult:
        """Check task scope limits"""
        # Get limits from task config or use defaults
        budget = task.change_budget or {}
        max_files = budget.get("max_files", self.max_files)
        max_dirs = budget.get("max_directories", self.max_directories)

        # Count unique directories in target paths
        directories = set()
        for path in task.target_paths:
            parts = Path(path).parts
            if parts:
                directories.add(parts[0] if len(parts) == 1 else "/".join(parts[:-1]))

        if len(task.target_paths) > max_files:
            return SafetyCheckResult(
                safe=False,
                reason=f"Task targets too many files ({len(task.target_paths)} > {max_files})",
            )

        if len(directories) > max_dirs:
            return SafetyCheckResult(
                safe=False,
                reason=f"Task spans too many directories ({len(directories)} > {max_dirs})",
            )

        return SafetyCheckResult(safe=True)

    def _is_forbidden_path(self, path: str) -> bool:
        """Check if path is forbidden"""
        path_lower = path.lower()

        for forbidden in self.forbidden_paths:
            if forbidden in path_lower:
                return True

        return False

    def _contains_sensitive_content(self, content: str) -> bool:
        """Check if content contains sensitive data"""
        for pattern in self.SENSITIVE_PATTERNS:
            if re.search(pattern, content, re.IGNORECASE):
                return True
        return False


class RateLimiter:
    """
    Rate limiting for task submission and API calls.

    Prevents runaway execution and API abuse.
    """

    def __init__(
        self,
        max_tasks_per_minute: int = 10,
        max_api_calls_per_minute: int = 60,
    ):
        self.max_tasks_per_minute = max_tasks_per_minute
        self.max_api_calls_per_minute = max_api_calls_per_minute
        self._task_times: List[float] = []
        self._api_call_times: List[float] = []

    def can_submit_task(self) -> bool:
        """Check if a new task can be submitted"""
        import time
        now = time.time()
        self._task_times = [t for t in self._task_times if now - t < 60]
        return len(self._task_times) < self.max_tasks_per_minute

    def record_task(self) -> None:
        """Record task submission"""
        import time
        self._task_times.append(time.time())

    def can_make_api_call(self) -> bool:
        """Check if an API call can be made"""
        import time
        now = time.time()
        self._api_call_times = [t for t in self._api_call_times if now - t < 60]
        return len(self._api_call_times) < self.max_api_calls_per_minute

    def record_api_call(self) -> None:
        """Record API call"""
        import time
        self._api_call_times.append(time.time())


# Global safety checker
_safety_checker: Optional[SafetyChecker] = None


def get_safety_checker() -> SafetyChecker:
    """Get the global safety checker"""
    global _safety_checker
    if _safety_checker is None:
        _safety_checker = SafetyChecker()
    return _safety_checker
