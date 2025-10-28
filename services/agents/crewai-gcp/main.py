from fastapi import FastAPI
from llm_router.router import get_router, AgentRole

app = FastAPI()

@app.get("/health")
def health():
    return {
        "status": "ok",
        "service": "crewai-prompt-synth",
        "role": "worker",
        "routing": "llm_router_v1"
    }

@app.post("/execute")
def execute():
    # Router usage example:
    # router = get_router()
    # result = router.complete(AgentRole.WORKER, prompt="Your prompt here")
    return {"status": "success"}
