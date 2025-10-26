from fastapi import FastAPI
app = FastAPI()

@app.get("/health")
def health():
    return {"status":"ok"}

@app.post("/execute")
def execute():
    return {"status":"success"}
