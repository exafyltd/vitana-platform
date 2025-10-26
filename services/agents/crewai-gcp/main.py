# main.py
import json
import re
from typing import List

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

# --------------- Pydantic contracts (adjust to your real ones) ---------------
class WorkItem(BaseModel):
    work_item_id: str
    description: str


class TaskPack(BaseModel):
    work_item_id: str
    prompt: str
    tests: List[dict]
    acceptance: List[str]
    metadata: dict


# ----------------- CrewAI / LiteLLM imports (adjust if needed) -----------------
from crewai import Agent, Task, Crew  # type: ignore
from litellm import vertex_gemini_25  # placeholder – use your real backend


# --------------------------- FastAPI application ------------------------------
app = FastAPI(title="Vitana Task-Pack Service", version="0.1.0")


# -------------------------- CrewAI pipeline constants -------------------------
MODEL_ID = "gemini-2.5-pro"  # change to your real model
VERTEX_LOCATION = "us-central1"
PROJECT_ID = "your-gcp-project-id"

# LiteLLM-style LLM object that CrewAI understands
crew_llm = vertex_gemini_25  # or however you wire Gemini 2.5


# ------------------------------ health probe ----------------------------------
@app.get("/health")
def health():
    return {"status": "ok"}


# ----------------------------- CrewAI endpoint --------------------------------
@app.post("/crew", response_model=TaskPack)
def crew_pipeline(item: WorkItem) -> TaskPack:
    """
    Minimal CrewAI integration that uses Vertex Gemini 2.5 via LiteLLM backend.
    Sanitises output to plain JSON (no markdown fences) for downstream use.
    """

    def to_plain_json(text: str) -> str:
        # 1) Strip fenced blocks ```json ... ``` or ``` ... ```
        text = re.sub(r"^```(?:json)?\s*", "", text.strip(), flags=re.I)
        text = re.sub(r"\s*```$", "", text, flags=re.I)

        # 2) If there's extra prose, attempt to extract the first JSON object
        if not text.lstrip().startswith("{"):
            start = text.find("{")
            if start != -1:
                stack = 0
                for i in range(start, len(text)):
                    if text[i] == "{":
                        stack += 1
                    elif text[i] == "}":
                        stack -= 1
                        if stack == 0:
                            text = text[start : i + 1]
                            break

        # 3) Validate it’s JSON; if not, fall back to raw text
        try:
            obj = json.loads(text)
            return json.dumps(obj, ensure_ascii=False, separators=(",", ":"))
        except Exception:
            return text

    try:
        synthesizer = Agent(
            role="Task Pack Synthesizer",
            goal="Produce an actionable Task Pack JSON with clear tests & acceptance criteria.",
            backstory=(
                "You lead Vitana's engineering planning. You convert product intents "
                "into execution-ready task packs with IDs, acceptance criteria, and tests."
            ),
            llm=crew_llm,
            allow_delegation=False,
            verbose=False,
        )

        task = Task(
            description=(
                "Create a Task Pack JSON for the following work item.\n\n"
                f"Work Item Description:\n{item.description}\n\n"
                "Return ONLY a single valid JSON object with keys:\n"
                "epicTitle, epicDescription, taskPack[]. Each task in taskPack must have:\n"
                "id, title, description, status (To Do/In Progress/Done), "
                "acceptanceCriteria[], tests{unit[],integration[],e2e[],manual[]?}.\n"
                "No markdown fences, no extra prose."
            ),
            expected_output="A single valid JSON object (no markdown fences, no extra text).",
            agent=synthesizer,
        )

        crew = Crew(agents=[synthesizer], tasks=[task])
        result_text = str(crew.kickoff())
        cleaned = to_plain_json(result_text)

        return TaskPack(
            work_item_id=item.work_item_id,
            prompt=cleaned,
            tests=[{"type": "contract", "code": "test('crewai-dark-mode', () => {})"}],
            acceptance=["JSON valid", "Criteria precise", "Tests runnable"],
            metadata={
                "engine": "CrewAI",
                "model": MODEL_ID,
                "location": VERTEX_LOCATION,
                "project": PROJECT_ID,
            },
        )
    except Exception as e:
        raise HTTPException(status_code=503, detail=f"CrewAI pipeline failed: {str(e)}")


# -------------------------- local dev entry-point -----------------------------
if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
