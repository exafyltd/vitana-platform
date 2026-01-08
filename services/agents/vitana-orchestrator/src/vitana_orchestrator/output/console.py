"""
Console Output Formatter

VTID: VTID-01175

Rich console output with colors and formatting.
"""

import sys
from datetime import datetime
from typing import Any, Dict, Optional

from .base import BaseFormatter, OutputLevel
from ..main import TaskState, TaskStatus


class ConsoleFormatter(BaseFormatter):
    """
    Console formatter with colored output.

    Uses ANSI escape codes for colors in terminal environments.
    Falls back to plain text when not in a TTY.
    """

    # ANSI color codes
    COLORS = {
        "reset": "\033[0m",
        "bold": "\033[1m",
        "dim": "\033[2m",
        "green": "\033[32m",
        "yellow": "\033[33m",
        "red": "\033[31m",
        "blue": "\033[34m",
        "cyan": "\033[36m",
        "magenta": "\033[35m",
    }

    # Status symbols
    SYMBOLS = {
        "pending": "○",
        "routing": "◐",
        "dispatched": "◑",
        "in_progress": "◔",
        "verifying": "◕",
        "completed": "●",
        "failed": "✗",
        "timeout": "⏱",
        "cancelled": "⊘",
    }

    def __init__(self, level: OutputLevel = OutputLevel.NORMAL, use_colors: bool = True):
        super().__init__(level)
        self.use_colors = use_colors and sys.stdout.isatty()

    def _c(self, color: str, text: str) -> str:
        """Apply color to text"""
        if self.use_colors:
            return f"{self.COLORS.get(color, '')}{text}{self.COLORS['reset']}"
        return text

    def _symbol(self, status: str) -> str:
        """Get symbol for status"""
        return self.SYMBOLS.get(status, "○")

    def _timestamp(self) -> str:
        """Get formatted timestamp"""
        return datetime.now().strftime("%H:%M:%S")

    def task_started(self, task: TaskState) -> None:
        """Format task started message"""
        symbol = self._c("blue", self._symbol("in_progress"))
        vtid = self._c("cyan", task.vtid)
        domain = self._c("dim", f"[{task.domain.value}]")

        print(f"{symbol} {vtid} {domain} {task.title}")

        if self.level >= OutputLevel.VERBOSE:
            print(f"  {self._c('dim', 'Task ID:')} {task.task_id}")
            if task.target_paths:
                print(f"  {self._c('dim', 'Targets:')} {', '.join(task.target_paths[:3])}")

    def task_progress(self, task: TaskState, message: str) -> None:
        """Format task progress message"""
        if self.level < OutputLevel.NORMAL:
            return

        symbol = self._symbol(task.status.value)
        status_color = {
            TaskStatus.ROUTING: "yellow",
            TaskStatus.DISPATCHED: "blue",
            TaskStatus.IN_PROGRESS: "cyan",
            TaskStatus.VERIFYING: "magenta",
        }.get(task.status, "dim")

        symbol = self._c(status_color, symbol)
        ts = self._c("dim", f"[{self._timestamp()}]")

        print(f"  {symbol} {ts} {message}")

    def task_completed(self, task: TaskState) -> None:
        """Format task completed message"""
        symbol = self._c("green", self._symbol("completed"))
        vtid = self._c("green", task.vtid)
        duration = ""

        if task.duration_ms:
            seconds = task.duration_ms / 1000
            duration = self._c("dim", f" ({seconds:.1f}s)")

        print(f"{symbol} {vtid} {self._c('green', 'COMPLETED')}{duration}")

        if self.level >= OutputLevel.VERBOSE and task.changes_made:
            print(f"  {self._c('dim', 'Changes:')} {len(task.changes_made)} file(s)")

    def task_failed(self, task: TaskState, error: str) -> None:
        """Format task failed message"""
        symbol = self._c("red", self._symbol("failed"))
        vtid = self._c("red", task.vtid)

        print(f"{symbol} {vtid} {self._c('red', 'FAILED')}")
        print(f"  {self._c('red', 'Error:')} {error}")

        if self.level >= OutputLevel.VERBOSE:
            if task.retry_count > 0:
                print(f"  {self._c('dim', 'Retries:')} {task.retry_count}")
            if task.retry_reasons:
                for reason in task.retry_reasons[-3:]:  # Show last 3
                    print(f"    {self._c('dim', '-')} {reason}")

    def verification_result(
        self,
        task: TaskState,
        passed: bool,
        details: Optional[Dict[str, Any]] = None,
    ) -> None:
        """Format verification result"""
        if passed:
            symbol = self._c("green", "✓")
            status = self._c("green", "VERIFIED")
        else:
            symbol = self._c("red", "✗")
            status = self._c("red", "VERIFICATION FAILED")

        print(f"  {symbol} {status}")

        if details and self.level >= OutputLevel.VERBOSE:
            if "missing_files" in details:
                print(f"    {self._c('red', 'Missing files:')}")
                for f in details["missing_files"][:5]:
                    print(f"      - {f}")

            if "issues" in details:
                for issue in details["issues"][:3]:
                    severity = issue.get("severity", "info")
                    color = {"critical": "red", "warning": "yellow"}.get(severity, "dim")
                    print(f"    {self._c(color, '-')} {issue.get('issue', 'Unknown issue')}")

    def summary(self, stats: Dict[str, Any]) -> None:
        """Format summary statistics"""
        print()
        print(self._c("bold", "═" * 50))
        print(self._c("bold", "  ORCHESTRATOR SUMMARY"))
        print(self._c("bold", "═" * 50))

        counters = stats.get("counters", {})
        rates = stats.get("rates", {})
        timing = stats.get("timing", {})

        # Task counts
        completed = counters.get("tasks_completed", 0)
        failed = counters.get("tasks_failed", 0)
        total = counters.get("tasks_submitted", 0)

        print(f"\n  {self._c('bold', 'Tasks:')}")
        print(f"    Completed: {self._c('green', str(completed))}")
        print(f"    Failed:    {self._c('red', str(failed))}")
        print(f"    Total:     {total}")

        # Verification
        v_passes = counters.get("verification_passes", 0)
        v_failures = counters.get("verification_failures", 0)
        false_completions = counters.get("false_completions_caught", 0)

        print(f"\n  {self._c('bold', 'Verification:')}")
        print(f"    Passes:             {self._c('green', str(v_passes))}")
        print(f"    Failures:           {self._c('red', str(v_failures))}")
        print(f"    False completions:  {self._c('yellow', str(false_completions))}")

        # Rates
        success_rate = rates.get("success_rate", 0) * 100
        v_rate = rates.get("verification_pass_rate", 0) * 100
        false_rate = rates.get("false_completion_rate", 0) * 100

        print(f"\n  {self._c('bold', 'Rates:')}")
        print(f"    Success rate:       {success_rate:.1f}%")
        print(f"    Verification rate:  {v_rate:.1f}%")
        print(f"    False completion:   {false_rate:.1f}%")

        # Timing
        avg_duration = timing.get("avg_task_duration_ms", 0) / 1000

        print(f"\n  {self._c('bold', 'Timing:')}")
        print(f"    Avg task duration:  {avg_duration:.1f}s")

        # Cost
        total_cost = counters.get("total_cost_usd", 0)
        total_tokens = counters.get("total_tokens", 0)

        print(f"\n  {self._c('bold', 'Cost:')}")
        print(f"    Total tokens:       {total_tokens:,}")
        print(f"    Total cost:         ${total_cost:.4f}")

        print()
        print(self._c("bold", "═" * 50))


def print_banner() -> None:
    """Print the orchestrator banner"""
    banner = """
╔═══════════════════════════════════════════════════════════╗
║                                                           ║
║   ██╗   ██╗██╗████████╗ █████╗ ███╗   ██╗ █████╗         ║
║   ██║   ██║██║╚══██╔══╝██╔══██╗████╗  ██║██╔══██╗        ║
║   ██║   ██║██║   ██║   ███████║██╔██╗ ██║███████║        ║
║   ╚██╗ ██╔╝██║   ██║   ██╔══██║██║╚██╗██║██╔══██║        ║
║    ╚████╔╝ ██║   ██║   ██║  ██║██║ ╚████║██║  ██║        ║
║     ╚═══╝  ╚═╝   ╚═╝   ╚═╝  ╚═╝╚═╝  ╚═══╝╚═╝  ╚═╝        ║
║                                                           ║
║              ORCHESTRATOR v1.0.0 (VTID-01175)             ║
║         Guaranteed Task Completion with Verification       ║
║                                                           ║
╚═══════════════════════════════════════════════════════════╝
"""
    print(banner)
