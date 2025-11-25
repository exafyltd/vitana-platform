from fastapi import FastAPI
from pydantic import BaseModel
import json, os
from vertexai.preview.generative_models import GenerativeModel

gemini = GenerativeModel("gemini-2.5-pro-exp-03-25")

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

@app.post("/run")
def run_crew(item: WorkItem) -> TaskPack:
    # Simple Gemini call – no CrewAI overhead
    prompt = gemini.generate_content(
        f"Create a Task Pack JSON for: {item.description}"
    ).text
    # Mock a valid pack (replace with real parsing later)
    return TaskPack(
        work_item_id=item.work_item_id,
        prompt=prompt,
        tests=[{"type": "contract", "code": "test('dark-mode', () => {})"}],
        acceptance=["Toggle works", "Persists in DB"],
        metadata={"max_tokens": 100000, "deadline": "2025-10-20", "model": "gemini-2.5-pro"}
    )
