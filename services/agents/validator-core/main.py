import sys
sys.path.insert(0, '/app')

from fastapi import FastAPI
from pydantic import BaseModel
import os
import asyncio

# Import our new LLM Router
from src.llm.router import LLMRouter, LLMProvider

class WorkItem(BaseModel):
    work_item_id: str
    description: str

class TaskPack(BaseModel):
    work_item_id: str
    prompt: str
    tests: list
    acceptance: list
    metadata: dict

app = FastAPI()

# Initialize router
PROJECT_ID = os.getenv("GCP_PROJECT", "lovable-vitana-vers1")
router = LLMRouter(PROJECT_ID)

@app.post("/run")
async def run_crew(item: WorkItem) -> TaskPack:
    """Run validator using LLM Router with fallback logic"""
    
    prompt = f"Create a Task Pack JSON for: {item.description}"
    
    try:
        # Use router - automatically handles Gemini → fallback to other LLMs
        response, provider_used, latency_ms, success = await router.invoke(
            role="validator",
            prompt=prompt,
        )
        
        print(f"✅ Validator used {provider_used.value} ({latency_ms:.0f}ms)")
        
        return TaskPack(
            work_item_id=item.work_item_id,
            prompt=response,
            tests=[{"type": "contract", "code": "test('dark-mode', () => {})"}],
            acceptance=["Toggle works", "Persists in DB"],
            metadata={
                "max_tokens": 100000, 
                "deadline": "2025-10-20", 
                "model": provider_used.value,
                "latency_ms": latency_ms
            }
        )
    except Exception as e:
        print(f"❌ Validator failed: {str(e)}")
        raise

@app.get("/health")
def health():
    return {"status": "ok", "service": "validator-core"}
