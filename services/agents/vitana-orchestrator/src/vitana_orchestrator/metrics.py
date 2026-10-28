"""
Metrics Tracking

VTID: VTID-01175

Tracks orchestrator metrics for monitoring and analysis.
"""

import json
import os
import time
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional


@dataclass
class TaskMetrics:
    """Metrics for a single task"""
    task_id: str
    vtid: str
    domain: str
    started_at: datetime
    completed_at: Optional[datetime] = None
    duration_ms: int = 0
    status: str = "pending"

    # Execution metrics
    dispatch_attempts: int = 0
    verification_attempts: int = 0
    retry_count: int = 0

    # Cost metrics
    tokens_used: int = 0
    cost_usd: float = 0.0

    # Verification metrics
    verification_passed: bool = False
    false_completion_detected: bool = False

    def to_dict(self) -> Dict[str, Any]:
        return {
            "task_id": self.task_id,
            "vtid": self.vtid,
            "domain": self.domain,
            "started_at": self.started_at.isoformat(),
            "completed_at": self.completed_at.isoformat() if self.completed_at else None,
            "duration_ms": self.duration_ms,
            "status": self.status,
            "dispatch_attempts": self.dispatch_attempts,
            "verification_attempts": self.verification_attempts,
            "retry_count": self.retry_count,
            "tokens_used": self.tokens_used,
            "cost_usd": self.cost_usd,
            "verification_passed": self.verification_passed,
            "false_completion_detected": self.false_completion_detected,
        }


class MetricsCollector:
    """
    Collects and stores metrics for the orchestrator.

    Provides real-time statistics and historical data export.
    """

    def __init__(self, metrics_path: Optional[Path] = None):
        self.metrics_path = metrics_path or Path(
            os.getenv("METRICS_PATH", ".vitana/metrics")
        )
        self.metrics_path.mkdir(parents=True, exist_ok=True)

        self._task_metrics: Dict[str, TaskMetrics] = {}
        self._start_time = datetime.now()

        # Aggregate counters
        self._counters = {
            "tasks_submitted": 0,
            "tasks_completed": 0,
            "tasks_failed": 0,
            "tasks_timeout": 0,
            "verification_passes": 0,
            "verification_failures": 0,
            "false_completions_caught": 0,
            "total_retries": 0,
            "total_tokens": 0,
            "total_cost_usd": 0.0,
        }

        # Timing histograms
        self._timing = {
            "task_duration_ms": [],
            "verification_duration_ms": [],
            "dispatch_latency_ms": [],
        }

    # =========================================================================
    # Task Tracking
    # =========================================================================

    def task_started(self, task_id: str, vtid: str, domain: str) -> None:
        """Record task start"""
        self._task_metrics[task_id] = TaskMetrics(
            task_id=task_id,
            vtid=vtid,
            domain=domain,
            started_at=datetime.now(),
        )
        self._counters["tasks_submitted"] += 1

    def task_dispatched(self, task_id: str) -> None:
        """Record task dispatch"""
        if task_id in self._task_metrics:
            self._task_metrics[task_id].dispatch_attempts += 1

    def task_completed(self, task_id: str, status: str) -> None:
        """Record task completion"""
        if task_id in self._task_metrics:
            metrics = self._task_metrics[task_id]
            metrics.completed_at = datetime.now()
            metrics.status = status

            if metrics.started_at:
                metrics.duration_ms = int(
                    (metrics.completed_at - metrics.started_at).total_seconds() * 1000
                )
                self._timing["task_duration_ms"].append(metrics.duration_ms)

            if status == "completed":
                self._counters["tasks_completed"] += 1
            elif status == "failed":
                self._counters["tasks_failed"] += 1
            elif status == "timeout":
                self._counters["tasks_timeout"] += 1

    def verification_recorded(
        self,
        task_id: str,
        passed: bool,
        false_completion: bool = False,
    ) -> None:
        """Record verification result"""
        if task_id in self._task_metrics:
            metrics = self._task_metrics[task_id]
            metrics.verification_attempts += 1
            metrics.verification_passed = passed
            metrics.false_completion_detected = false_completion

        if passed:
            self._counters["verification_passes"] += 1
        else:
            self._counters["verification_failures"] += 1

        if false_completion:
            self._counters["false_completions_caught"] += 1

    def retry_recorded(self, task_id: str) -> None:
        """Record retry attempt"""
        if task_id in self._task_metrics:
            self._task_metrics[task_id].retry_count += 1
        self._counters["total_retries"] += 1

    def cost_recorded(self, task_id: str, tokens: int, cost: float) -> None:
        """Record token usage and cost"""
        if task_id in self._task_metrics:
            self._task_metrics[task_id].tokens_used += tokens
            self._task_metrics[task_id].cost_usd += cost

        self._counters["total_tokens"] += tokens
        self._counters["total_cost_usd"] += cost

    # =========================================================================
    # Statistics
    # =========================================================================

    def get_summary(self) -> Dict[str, Any]:
        """Get summary statistics"""
        uptime_seconds = (datetime.now() - self._start_time).total_seconds()

        task_durations = self._timing["task_duration_ms"]
        avg_duration = sum(task_durations) / len(task_durations) if task_durations else 0

        return {
            "uptime_seconds": int(uptime_seconds),
            "counters": self._counters.copy(),
            "rates": {
                "tasks_per_hour": (
                    self._counters["tasks_submitted"] / (uptime_seconds / 3600)
                    if uptime_seconds > 0 else 0
                ),
                "success_rate": (
                    self._counters["tasks_completed"] / self._counters["tasks_submitted"]
                    if self._counters["tasks_submitted"] > 0 else 0
                ),
                "verification_pass_rate": (
                    self._counters["verification_passes"] /
                    (self._counters["verification_passes"] + self._counters["verification_failures"])
                    if (self._counters["verification_passes"] + self._counters["verification_failures"]) > 0 else 0
                ),
                "false_completion_rate": (
                    self._counters["false_completions_caught"] / self._counters["tasks_submitted"]
                    if self._counters["tasks_submitted"] > 0 else 0
                ),
            },
            "timing": {
                "avg_task_duration_ms": avg_duration,
                "min_task_duration_ms": min(task_durations) if task_durations else 0,
                "max_task_duration_ms": max(task_durations) if task_durations else 0,
            },
        }

    def get_task_metrics(self, task_id: str) -> Optional[Dict[str, Any]]:
        """Get metrics for a specific task"""
        if task_id in self._task_metrics:
            return self._task_metrics[task_id].to_dict()
        return None

    # =========================================================================
    # Export
    # =========================================================================

    def export_metrics(self, filename: Optional[str] = None) -> Path:
        """Export metrics to JSON file"""
        if filename is None:
            filename = f"metrics_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json"

        filepath = self.metrics_path / filename

        data = {
            "exported_at": datetime.now().isoformat(),
            "summary": self.get_summary(),
            "tasks": [m.to_dict() for m in self._task_metrics.values()],
        }

        with open(filepath, "w") as f:
            json.dump(data, f, indent=2)

        return filepath

    def reset(self) -> None:
        """Reset all metrics"""
        self._task_metrics.clear()
        self._start_time = datetime.now()
        for key in self._counters:
            if isinstance(self._counters[key], int):
                self._counters[key] = 0
            else:
                self._counters[key] = 0.0
        for key in self._timing:
            self._timing[key] = []


# Global instance
_metrics_collector: Optional[MetricsCollector] = None


def get_metrics() -> MetricsCollector:
    """Get the global metrics collector"""
    global _metrics_collector
    if _metrics_collector is None:
        _metrics_collector = MetricsCollector()
    return _metrics_collector
