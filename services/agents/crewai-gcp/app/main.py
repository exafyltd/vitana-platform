from fastapi import FastAPI
app = FastAPI()

@app.get("/")
def root():
    return {"service": "crewai-gcp", "status": "running"}

@app.get("/healthz")
def healthz():
    return "ok"
