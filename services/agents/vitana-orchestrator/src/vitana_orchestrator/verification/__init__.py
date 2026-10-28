"""
Verification System - VTID-01175

Verification engine subsystem for the Worker Orchestrator (VTID-01163).
Provides domain-specific validators and verification checks.

This is NOT an orchestrator - it's a library used by the orchestrator
to validate worker output before marking tasks complete.
"""

from .verifier import (
    CompletionVerifier,
    VerificationConfig,
    VerificationOutcome,
    CheckResult,
)
from .validators import (
    BackendValidator,
    FrontendValidator,
    MemoryValidator,
    ValidationResult,
    Validator,
    get_validators_for_domain,
)

__all__ = [
    # Verifier
    "CompletionVerifier",
    "VerificationConfig",
    "VerificationOutcome",
    "CheckResult",
    # Validators
    "Validator",
    "ValidationResult",
    "FrontendValidator",
    "BackendValidator",
    "MemoryValidator",
    "get_validators_for_domain",
]
