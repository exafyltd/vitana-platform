from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from typing import Optional
import os
import httpx

app = FastAPI()

class ApprovalRequest(BaseModel):
    vtid: str
    deployment_id: str
    approver: str
    decision: str  # "approve" or "reject"
    reason: Optional[str] = None

@app.post("/api/v1/approvals")
async def create_approval(request: ApprovalRequest):
    """Handle deployment approval/rejection"""
    
    if request.decision not in ["approve", "reject"]:
        raise HTTPException(status_code=400, detail="Decision must be 'approve' or 'reject'")
    
    # Emit OASIS event
    supabase_url = os.getenv("SUPABASE_URL")
    supabase_key = os.getenv("SUPABASE_SERVICE_ROLE")
    
    event_data = {
        "event_type": f"deployment.{request.decision}d",
        "vtid": request.vtid,
        "source_service": "oasis-approval",
        "actor": request.approver,
        "environment": "approval",
        "metadata": {
            "deployment_id": request.deployment_id,
            "decision": request.decision,
            "reason": request.reason
        }
    }
    
    async with httpx.AsyncClient() as client:
        response = await client.post(
            f"{supabase_url}/rest/v1/events",
            headers={
                "apikey": supabase_key,
                "Content-Type": "application/json"
            },
            json=event_data
        )
    
    if response.status_code != 201:
        raise HTTPException(status_code=500, detail="Failed to emit OASIS event")
    
    return {
        "status": "success",
        "vtid": request.vtid,
        "decision": request.decision,
        "approver": request.approver
    }

@app.get("/health")
async def health():
    return {"status": "ok", "service": "oasis-approval"}
