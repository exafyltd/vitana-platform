"""
Configuration and Types for Vitana Orchestrator

VTID: VTID-01175
"""

import os
import uuid
from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from pathlib import Path
from typing import Any, Dict, List, Optional


class TaskStatus(Enum):
    """Task lifecycle status"""
    PENDING = "pending"
    ROUTING = "routing"
    DISPATCHED = "dispatched"
    IN_PROGRESS = "in_progress"
    VERIFYING = "verifying"
    VERIFICATION_FAILED = "verification_failed"
    RETRY_PENDING = "retry_pending"
    COMPLETED = "completed"
    FAILED = "failed"
    TIMEOUT = "timeout"
    CANCELLED = "cancelled"


class TaskDomain(Enum):
    """Worker domain types"""
    FRONTEND = "frontend"
    BACKEND = "backend"
    MEMORY = "memory"
    MIXED = "mixed"


class AgentRole(Enum):
    """Agent role types for routing"""
    PLANNER = "planner"
    WORKER = "worker"
    VALIDATOR = "validator"
    ORCHESTRATOR = "orchestrator"


class VerificationResult(Enum):
    """Result of task verification"""
    PASSED = "passed"
    FAILED = "failed"
    PARTIAL = "partial"
    NEEDS_RETRY = "needs_retry"
    CANNOT_VERIFY = "cannot_verify"


@dataclass
class TaskState:
    """
    Complete state of a task throughout its lifecycle.

    Tracks every aspect of task execution for audit and debugging.
    """
    task_id: str
    vtid: str
    title: str
    description: str
    domain: TaskDomain
    status: TaskStatus = TaskStatus.PENDING

    # Execution tracking
    assigned_agent: Optional[str] = None
    assigned_at: Optional[datetime] = None
    started_at: Optional[datetime] = None
    completed_at: Optional[datetime] = None

    # Verification tracking
    verification_attempts: int = 0
    last_verification_at: Optional[datetime] = None
    verification_result: Optional[VerificationResult] = None
    verification_details: Dict[str, Any] = field(default_factory=dict)

    # Retry tracking
    retry_count: int = 0
    max_retries: int = 3
    retry_reasons: List[str] = field(default_factory=list)

    # Results and artifacts
    result: Optional[Dict[str, Any]] = None
    artifacts: List[str] = field(default_factory=list)
    changes_made: List[Dict[str, Any]] = field(default_factory=list)

    # Error tracking
    error: Optional[str] = None
    error_history: List[Dict[str, Any]] = field(default_factory=list)

    # Metadata
    metadata: Dict[str, Any] = field(default_factory=dict)
    target_paths: List[str] = field(default_factory=list)
    change_budget: Optional[Dict[str, int]] = None

    # OASIS integration
    oasis_events: List[str] = field(default_factory=list)

    @property
    def is_terminal(self) -> bool:
        """Check if task is in terminal state"""
        return self.status in {
            TaskStatus.COMPLETED,
            TaskStatus.FAILED,
            TaskStatus.TIMEOUT,
            TaskStatus.CANCELLED,
        }

    @property
    def can_retry(self) -> bool:
        """Check if task can be retried"""
        return (
            not self.is_terminal and
            self.retry_count < self.max_retries
        )

    @property
    def duration_ms(self) -> Optional[int]:
        """Calculate task duration in milliseconds"""
        if self.started_at and self.completed_at:
            delta = self.completed_at - self.started_at
            return int(delta.total_seconds() * 1000)
        return None

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for serialization"""
        return {
            "task_id": self.task_id,
            "vtid": self.vtid,
            "title": self.title,
            "description": self.description,
            "domain": self.domain.value,
            "status": self.status.value,
            "assigned_agent": self.assigned_agent,
            "assigned_at": self.assigned_at.isoformat() if self.assigned_at else None,
            "started_at": self.started_at.isoformat() if self.started_at else None,
            "completed_at": self.completed_at.isoformat() if self.completed_at else None,
            "verification_attempts": self.verification_attempts,
            "last_verification_at": self.last_verification_at.isoformat() if self.last_verification_at else None,
            "verification_result": self.verification_result.value if self.verification_result else None,
            "verification_details": self.verification_details,
            "retry_count": self.retry_count,
            "max_retries": self.max_retries,
            "retry_reasons": self.retry_reasons,
            "result": self.result,
            "artifacts": self.artifacts,
            "changes_made": self.changes_made,
            "error": self.error,
            "error_history": self.error_history,
            "metadata": self.metadata,
            "target_paths": self.target_paths,
            "change_budget": self.change_budget,
            "oasis_events": self.oasis_events,
            "duration_ms": self.duration_ms,
        }


@dataclass
class TaskConfig:
    """Configuration for a task to be executed"""
    vtid: str
    title: str
    description: str = ""
    domain: Optional[TaskDomain] = None
    target_paths: List[str] = field(default_factory=list)
    change_budget: Optional[Dict[str, int]] = None
    max_retries: int = 3
    timeout_ms: int = 1800000  # 30 minutes
    require_verification: bool = True
    metadata: Dict[str, Any] = field(default_factory=dict)

    def to_task_state(self) -> TaskState:
        """Create TaskState from this config"""
        return TaskState(
            task_id=str(uuid.uuid4()),
            vtid=self.vtid,
            title=self.title,
            description=self.description,
            domain=self.domain or TaskDomain.BACKEND,
            max_retries=self.max_retries,
            target_paths=self.target_paths,
            change_budget=self.change_budget,
            metadata=self.metadata,
        )


@dataclass
class OrchestratorConfig:
    """
    Configuration for the Vitana Orchestrator.

    Controls behavior, timeouts, and integration settings.
    """
    # Identity
    vtid: str = "VTID-01175"
    name: str = "vitana-orchestrator"
    version: str = "1.0.0"

    # Execution settings
    max_concurrent_tasks: int = 5
    default_task_timeout_ms: int = 1800000  # 30 minutes
    verification_timeout_ms: int = 60000    # 1 minute
    polling_interval_ms: int = 5000         # 5 seconds

    # Verification settings
    max_verification_attempts: int = 3
    verification_required: bool = True
    auto_retry_on_verification_failure: bool = True

    # Retry settings
    max_retries: int = 3
    retry_delay_ms: int = 10000  # 10 seconds
    retry_backoff_multiplier: float = 2.0

    # Safety limits
    max_files_per_task: int = 20
    max_directories_per_task: int = 10

    # Provider settings
    primary_provider: str = "claude"
    fallback_provider: str = "gemini"
    model_preference: str = "claude-3-5-sonnet-20241022"

    # Integration URLs
    oasis_gateway_url: str = field(
        default_factory=lambda: os.getenv("OASIS_GATEWAY_URL", "http://localhost:8080")
    )
    memory_service_url: str = field(
        default_factory=lambda: os.getenv("MEMORY_SERVICE_URL", "http://localhost:8081")
    )

    # Paths
    workspace_path: Path = field(
        default_factory=lambda: Path(os.getenv("WORKSPACE_PATH", "/mnt/project"))
    )
    checkpoint_path: Path = field(
        default_factory=lambda: Path(os.getenv("CHECKPOINT_PATH", ".vitana/checkpoints"))
    )
    metrics_path: Path = field(
        default_factory=lambda: Path(os.getenv("METRICS_PATH", ".vitana/metrics"))
    )

    # Feature flags
    enable_preflight_checks: bool = True
    enable_postflight_validation: bool = True
    enable_oasis_events: bool = True
    enable_memory_integration: bool = True
    enable_metrics: bool = True
    enable_checkpointing: bool = True

    @classmethod
    def from_yaml(cls, path: str) -> "OrchestratorConfig":
        """Load config from YAML file"""
        import yaml

        with open(path, "r") as f:
            data = yaml.safe_load(f)

        return cls(**data)

    @classmethod
    def from_env(cls) -> "OrchestratorConfig":
        """Load config from environment variables"""
        return cls(
            max_concurrent_tasks=int(os.getenv("ORCH_MAX_CONCURRENT", "5")),
            default_task_timeout_ms=int(os.getenv("ORCH_TASK_TIMEOUT_MS", "1800000")),
            verification_required=os.getenv("ORCH_VERIFICATION_REQUIRED", "true").lower() == "true",
            max_retries=int(os.getenv("ORCH_MAX_RETRIES", "3")),
            primary_provider=os.getenv("ORCH_PRIMARY_PROVIDER", "claude"),
            fallback_provider=os.getenv("ORCH_FALLBACK_PROVIDER", "gemini"),
        )


# Domain detection keywords (from routing.yaml)
DOMAIN_KEYWORDS = {
    TaskDomain.FRONTEND: {
        "Command Hub", "UI", "CSS", "SPA", "CSP", "styles", "orb overlay",
        "frontend", "component", "layout", "button", "modal", "form",
        "input", "display", "render", "view", "page", "template", "tailwind",
        "web", "browser",
    },
    TaskDomain.BACKEND: {
        "endpoint", "api/v1", "gateway", "controller", "route mount", "SSE",
        "operator", "service", "middleware", "handler", "API", "REST",
        "POST", "GET", "PATCH", "DELETE", "express", "router", "request",
        "response", "authentication", "authorization", "CICD", "deploy",
    },
    TaskDomain.MEMORY: {
        "supabase", "rpc", "vectors", "qdrant", "mem0", "embedding", "context",
        "memory", "migration", "database", "table", "schema", "index", "query",
        "OASIS", "ledger", "tenant", "user context",
    },
}

DOMAIN_PATH_PATTERNS = {
    TaskDomain.FRONTEND: [
        "services/gateway/src/frontend/**",
        "services/gateway/dist/frontend/**",
        "**/*.html",
        "**/*.css",
        "**/frontend/**",
        "**/web/**",
    ],
    TaskDomain.BACKEND: [
        "services/gateway/src/**",
        "services/**/src/**",
        "**/*.ts",
        "**/routes/**",
        "**/controllers/**",
        "**/services/**",
        "**/middleware/**",
    ],
    TaskDomain.MEMORY: [
        "supabase/migrations/**",
        "services/agents/memory-indexer/**",
        "**/memory/**",
        "**/*.sql",
    ],
}


def detect_domain(title: str, description: str = "", target_paths: List[str] = None) -> TaskDomain:
    """
    Detect task domain from title, description, and target paths.

    Uses keyword matching and path pattern analysis.
    """
    text = f"{title} {description}".lower()
    paths = target_paths or []

    scores = {
        TaskDomain.FRONTEND: 0,
        TaskDomain.BACKEND: 0,
        TaskDomain.MEMORY: 0,
    }

    # Check keywords
    for domain, keywords in DOMAIN_KEYWORDS.items():
        for keyword in keywords:
            if keyword.lower() in text:
                scores[domain] += 1

    # Check path patterns
    for domain, patterns in DOMAIN_PATH_PATTERNS.items():
        for path in paths:
            for pattern in patterns:
                if _path_matches_pattern(path, pattern):
                    scores[domain] += 2  # Paths are more definitive

    # Priority order: memory > backend > frontend
    if scores[TaskDomain.MEMORY] > 0:
        if scores[TaskDomain.BACKEND] > 0 or scores[TaskDomain.FRONTEND] > 0:
            return TaskDomain.MIXED
        return TaskDomain.MEMORY

    if scores[TaskDomain.BACKEND] > 0:
        if scores[TaskDomain.FRONTEND] > 0:
            return TaskDomain.MIXED
        return TaskDomain.BACKEND

    if scores[TaskDomain.FRONTEND] > 0:
        return TaskDomain.FRONTEND

    # Default to backend
    return TaskDomain.BACKEND


def _path_matches_pattern(path: str, pattern: str) -> bool:
    """Simple glob pattern matching"""
    import fnmatch

    # Handle negation patterns
    if pattern.startswith("!"):
        return not fnmatch.fnmatch(path, pattern[1:])

    return fnmatch.fnmatch(path, pattern)
