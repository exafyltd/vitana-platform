"""
VTID-01230: Conductor Service — LLM Router Proxy

The Conductor's role is to expose the centralized LLM Router as an HTTP
service. The canonical execution plane is the worker-runner (VTID-01200).

The Conductor does NOT orchestrate tasks. It provides:
  - LLM routing for any service that needs role-based model dispatch
  - Health check with routing policy info
  - /crew endpoint for CrewAI adapter compatibility

For task orchestration, see: services/worker-runner/
"""

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from typing import Optional, Dict, Any
import os

app = FastAPI(
    title="Vitana Conductor - LLM Router",
    description="Centralized LLM routing service. Execution plane is worker-runner (VTID-01200).",
    version="2.0.0",
)

# Lazy import router to avoid startup failures if dependencies are missing
_router = None

def _get_router():
    global _router
    if _router is None:
        try:
            from importlib import import_module
            import sys
            # Add llm-router to path
            router_path = os.path.join(os.path.dirname(__file__), 'llm-router')
            if router_path not in sys.path:
                sys.path.insert(0, router_path)
            from router import get_router
            _router = get_router("conductor")
        except Exception as e:
            print(f"[Conductor] WARNING: LLM Router not available: {e}")
    return _router


class LLMRequest(BaseModel):
    role: str  # "planner" | "worker" | "validator"
    prompt: str
    max_tokens: int = 4000
    temperature: float = 0.7
    vtid: Optional[str] = None
    metadata: Optional[Dict[str, Any]] = None


@app.get("/health")
def health():
    router = _get_router()
    policy_info = {}
    if router:
        policy_info = {
            role.value: {
                "primary": p["primary"]["model"],
                "fallback": p["fallback"]["model"],
            }
            for role, p in router.ROUTING_POLICY.items()
        }

    return {
        "status": "ok",
        "service": "conductor",
        "version": "2.0.0",
        "role": "llm-router",
        "routing": "crew_yaml_v2",
        "execution_plane": "worker-runner (VTID-01200)",
        "policy": policy_info,
    }


@app.post("/crew")
def crew():
    """Legacy endpoint for CrewAI adapter compatibility."""
    return {"status": "success"}


@app.post("/llm/complete")
def llm_complete(request: LLMRequest):
    """
    Route an LLM request through the centralized router.
    Model selection is based on role, as defined in crew.yaml.
    """
    router = _get_router()
    if not router:
        raise HTTPException(status_code=503, detail="LLM Router not initialized")

    from router import AgentRole

    role_map = {
        "planner": AgentRole.PLANNER,
        "worker": AgentRole.WORKER,
        "validator": AgentRole.VALIDATOR,
    }

    agent_role = role_map.get(request.role)
    if not agent_role:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid role: {request.role}. Must be one of: planner, worker, validator"
        )

    result = router.complete(
        role=agent_role,
        prompt=request.prompt,
        max_tokens=request.max_tokens,
        temperature=request.temperature,
        vtid=request.vtid,
        metadata=request.metadata,
    )

    return result
