from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from typing import Optional, List, Dict, Any
import httpx
import os
import json
import asyncio
from datetime import datetime, timedelta
import logging

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="OASIS Operator", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

class ChatRequest(BaseModel):
    user_id: str
    message: str
    vtid: Optional[str] = None
    topic: Optional[str] = None
    urgency: Optional[str] = "normal"

class ChatResponse(BaseModel):
    vtid: str
    reply: str
    followups: Optional[List[str]] = []
    links: Optional[List[str]] = []

SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_KEY = os.getenv("SUPABASE_SERVICE_ROLE")
CONDUCTOR_URL = os.getenv("CONDUCTOR_URL", "https://conductor-86804897789.us-central1.run.app")

async def emit_event(event_type: str, vtid: str, metadata: Dict[str, Any], actor: str = "operator"):
    try:
        async with httpx.AsyncClient() as client:
            await client.post(
                f"{SUPABASE_URL}/rest/v1/events",
                headers={"apikey": SUPABASE_KEY, "Content-Type": "application/json", "Prefer": "return=minimal"},
                json={"event_type": event_type, "vtid": vtid, "source_service": "oasis-operator", "actor": actor, "environment": "prod", "metadata": metadata},
                timeout=5.0
            )
    except Exception as e:
        logger.error(f"Failed to emit event: {e}")

async def create_vtid(topic: str) -> str:
    import uuid
    short_id = str(uuid.uuid4())[:8].upper()
    vtid = f"DEV-OPER-{short_id}"
    await emit_event("task.created", vtid, {"topic": topic, "created_via": "operator_chat"})
    return vtid

async def call_llm(message: str, vtid: str) -> str:
    try:
        async with httpx.AsyncClient() as client:
            response = await client.post(f"{CONDUCTOR_URL}/crew", json={"task": message, "context": {"vtid": vtid}}, timeout=30.0)
            if response.status_code == 200:
                return f"Task acknowledged for {vtid}. Processing via AI agents."
            else:
                return f"Received your request for {vtid}. Task queued."
    except Exception as e:
        logger.error(f"LLM call failed: {e}")
        return f"Message received for {vtid}. Processing."

@app.post("/api/v1/chat")
async def chat(request: ChatRequest):
    if not request.vtid:
        request.vtid = await create_vtid(request.topic or request.message[:50])
    
    await emit_event("chat.message.in", request.vtid, {"user_id": request.user_id, "message": request.message, "urgency": request.urgency}, actor=request.user_id)
    reply = await call_llm(request.message, request.vtid)
    await emit_event("chat.message.out", request.vtid, {"reply": reply, "tokens": len(reply.split())})
    
    return {"vtid": request.vtid, "reply": reply, "followups": ["What's the status?"], "links": [f"https://console.vitana.dev/vtid/{request.vtid}"]}

@app.get("/api/v1/chat/thread")
async def get_thread(vtid: str):
    try:
        async with httpx.AsyncClient() as client:
            response = await client.get(f"{SUPABASE_URL}/rest/v1/events", headers={"apikey": SUPABASE_KEY}, params={"vtid": f"eq.{vtid}", "event_type": "in.(chat.message.in,chat.message.out)", "order": "timestamp.asc"})
            if response.status_code == 200:
                events = response.json()
                items = [{"role": "user" if e["event_type"] == "chat.message.in" else "operator", "ts": e["timestamp"], "text": e["metadata"].get("message" if e["event_type"] == "chat.message.in" else "reply", "")} for e in events]
                return {"items": items, "next_cursor": None}
            else:
                raise HTTPException(status_code=500, detail="Failed to fetch thread")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/v1/events")
async def get_events(cursor: Optional[str] = None, limit: int = 50):
    try:
        since = datetime.utcnow() - timedelta(hours=72)
        async with httpx.AsyncClient() as client:
            response = await client.get(f"{SUPABASE_URL}/rest/v1/events", headers={"apikey": SUPABASE_KEY}, params={"timestamp": f"gte.{since.isoformat()}", "order": "timestamp.desc", "limit": limit})
            if response.status_code == 200:
                items = response.json()
                next_cursor = items[-1]["id"] if len(items) == limit else None
                return {"items": items, "next_cursor": next_cursor}
            else:
                raise HTTPException(status_code=500)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/v1/events/stream")
async def stream_events():
    async def event_generator():
        last_id = None
        while True:
            try:
                async with httpx.AsyncClient() as client:
                    params = {"order": "timestamp.desc", "limit": 10}
                    if last_id:
                        params["id"] = f"gt.{last_id}"
                    response = await client.get(f"{SUPABASE_URL}/rest/v1/events", headers={"apikey": SUPABASE_KEY}, params=params)
                    if response.status_code == 200:
                        events = response.json()
                        for event in reversed(events):
                            yield f"data: {json.dumps(event)}\n\n"
                            last_id = event["id"]
                await asyncio.sleep(2)
            except Exception as e:
                logger.error(f"SSE error: {e}")
                await asyncio.sleep(5)
    return StreamingResponse(event_generator(), media_type="text/event-stream")

@app.get("/health")
async def health():
    return {"status": "ok", "service": "oasis-operator", "timestamp": datetime.utcnow().isoformat()}

@app.on_event("startup")
async def startup():
    await emit_event("operator.health", "SYSTEM", {"status": "started"})
