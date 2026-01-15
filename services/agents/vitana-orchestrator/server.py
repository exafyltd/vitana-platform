"""
Vitana Verification Engine - HTTP Server
VTID-01175

FastAPI server for Cloud Run deployment. Provides HTTP endpoints
for the Worker Orchestrator (VTID-01163) to call the verification stage gate.

CRITICAL: This service does NOT claim task completion. It returns verification
results that the orchestrator uses to make decisions. OASIS remains the sole
authority for terminal task status.
"""

import logging
import os
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from vitana_orchestrator import (
    StageGateConfig,
    StageGateResult,
    TaskDomain,
    VerificationStageGate,
    __version__,
    __vtid__,
)

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger(__name__)

# Create FastAPI app
app = FastAPI(
    title="Vitana Verification Engine",
    description="Verification subsystem for Worker Orchestrator (VTID-01163)",
    version=__version__,
)

# Initialize stage gate with config from environment
config = StageGateConfig(
    oasis_gateway_url=os.getenv("OASIS_GATEWAY_URL", "http://localhost:8080"),
    tenant=os.getenv("VITANA_TENANT", "vitana-dev"),
    workspace_path=Path(os.getenv("WORKSPACE_PATH", "/mnt/project")),
    git_sha=os.getenv("GIT_SHA", "unknown"),
)
stage_gate = VerificationStageGate(config)


# --- Request/Response Models ---


class FileChange(BaseModel):
    """A file change claimed by a worker"""

    file_path: str = Field(..., description="Path to the changed file")
    action: str = Field(
        default="modified", description="Type of change: created, modified, deleted"
    )


class VerifyRequest(BaseModel):
    """Request to verify worker output"""

    vtid: str = Field(..., description="Task VTID for tracking")
    domain: str = Field(..., description="Task domain: frontend, backend, memory, mixed")
    claimed_changes: List[FileChange] = Field(
        default_factory=list, description="Files the worker claims to have changed"
    )
    claimed_output: str = Field(default="", description="Raw output from worker")
    started_at: Optional[str] = Field(
        default=None, description="ISO timestamp when task started"
    )
    metadata: Optional[Dict[str, Any]] = Field(
        default=None, description="Additional context"
    )


class VerifyResponse(BaseModel):
    """Response from verification"""

    passed: bool
    verification_result: str
    reason: str
    checks_run: List[str]
    checks_passed: List[str]
    checks_failed: List[str]
    duration_ms: int
    oasis_event_id: Optional[str]
    recommended_action: str
    details: Dict[str, Any]


# --- Endpoints ---


@app.get("/health")
def health() -> Dict[str, str]:
    """Health check endpoint for Cloud Run"""
    return {
        "status": "ok",
        "service": "vitana-verification-engine",
        "vtid": __vtid__,
        "version": __version__,
        "role": "verification-subsystem",
        "routing": "llm_router_v1",
    }


@app.post("/verify", response_model=VerifyResponse)
async def verify(request: VerifyRequest) -> VerifyResponse:
    """
    Verify worker output before orchestrator marks completion.

    Called by Worker Orchestrator (VTID-01163) after a worker claims
    it has completed a task. Returns verification results and
    recommendations - the orchestrator decides what to do next.

    This endpoint:
    1. Validates file existence
    2. Checks modification times
    3. Runs domain-specific validators
    4. Emits OASIS verification stage events

    It does NOT:
    - Mark tasks as complete (orchestrator's job)
    - Emit terminal OASIS events (orchestrator's job)
    - Retry workers (orchestrator's job)
    """
    logger.info(f"Verification request for {request.vtid} (domain={request.domain})")

    # Parse domain
    try:
        domain = TaskDomain(request.domain.lower())
    except ValueError:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid domain: {request.domain}. Must be one of: frontend, backend, memory, mixed",
        )

    # Parse started_at if provided
    started_at = None
    if request.started_at:
        try:
            started_at = datetime.fromisoformat(request.started_at.replace("Z", "+00:00"))
        except ValueError:
            logger.warning(f"Invalid started_at format: {request.started_at}")

    # Convert changes to dict format
    claimed_changes = [
        {"file_path": c.file_path, "action": c.action} for c in request.claimed_changes
    ]

    # Run verification
    result: StageGateResult = await stage_gate.verify(
        vtid=request.vtid,
        domain=domain,
        claimed_changes=claimed_changes,
        claimed_output=request.claimed_output,
        started_at=started_at,
        metadata=request.metadata,
    )

    return VerifyResponse(
        passed=result.passed,
        verification_result=result.verification_result.value,
        reason=result.reason,
        checks_run=result.checks_run,
        checks_passed=result.checks_passed,
        checks_failed=result.checks_failed,
        duration_ms=result.duration_ms,
        oasis_event_id=result.oasis_event_id,
        recommended_action=result.recommended_action,
        details=result.details,
    )


@app.get("/")
def root() -> Dict[str, str]:
    """Root endpoint with service info"""
    return {
        "service": "vitana-verification-engine",
        "vtid": __vtid__,
        "version": __version__,
        "description": "Verification subsystem for Worker Orchestrator (VTID-01163)",
        "note": "This service does NOT claim completion - OASIS is the sole authority",
    }
