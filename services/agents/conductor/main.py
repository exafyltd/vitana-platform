from fastapi import FastAPI

app = FastAPI()

@app.get("/health")
def health():
    return {
        "status": "ok",
        "service": "conductor",
        "role": "planner",
        "routing": "llm_router_v1"
    }

@app.post("/crew")
def crew():
    return {"status": "success"}
