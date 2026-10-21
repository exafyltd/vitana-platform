"""
Vitana Verification Engine - VTID-01175

Verification subsystem for the Worker Orchestrator (VTID-01163).
This is NOT a standalone orchestrator - it provides verification stage gates
that integrate into the existing production orchestration flow.

CRITICAL RULES:
1. This subsystem does NOT claim completion - OASIS is the sole authority
2. All verification results must be written as OASIS stage events
3. Never bypass the existing Worker Orchestrator (VTID-01163)
4. Verification passes/fails inform the orchestrator, not replace it
"""

__version__ = "1.1.0"
__vtid__ = "VTID-01175"

# Primary exports - Verification Engine (used by VTID-01163)
from .verification import (
    CompletionVerifier,
    VerificationConfig,
    VerificationOutcome,
    Validator,
    ValidationResult,
    FrontendValidator,
    BackendValidator,
    MemoryValidator,
    get_validators_for_domain,
)

# Stage gate for orchestrator integration
from .stage_gate import (
    VerificationStageGate,
    StageGateConfig,
    StageGateResult,
)

# Supporting types
from .main import TaskDomain, VerificationResult

# Safety checks (used by orchestrator)
from .safety import SafetyChecker, SafetyCheckResult

__all__ = [
    # Verification Engine
    "CompletionVerifier",
    "VerificationConfig",
    "VerificationOutcome",
    # Validators
    "Validator",
    "ValidationResult",
    "FrontendValidator",
    "BackendValidator",
    "MemoryValidator",
    "get_validators_for_domain",
    # Stage Gate (orchestrator integration)
    "VerificationStageGate",
    "StageGateConfig",
    "StageGateResult",
    # Types
    "TaskDomain",
    "VerificationResult",
    # Safety
    "SafetyChecker",
    "SafetyCheckResult",
    # Meta
    "__version__",
    "__vtid__",
]
