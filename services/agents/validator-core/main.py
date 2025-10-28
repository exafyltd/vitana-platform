from fastapi import FastAPI

app = FastAPI()

@app.get("/health")
def health():
    return {
        "status": "ok",
        "service": "validator-core",
        "role": "validator",
        "routing": "llm_router_v1"
    }

@app.post("/run")
def run():
    return {"status": "success"}
