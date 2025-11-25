from fastapi import FastAPI
from llm_router.router import get_router, AgentRole

app = FastAPI()

@app.get("/health")
def health():
    return {
        "status": "ok",
        "service": "worker-core",
        "role": "worker",
        "routing": "llm_router_v1"
    }

@app.post("/execute")
def execute():
    return {"status": "success"}
