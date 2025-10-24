"""Planner-Core: LFCE logic, path selection."""
from dataclasses import dataclass

@dataclass
class PlannerCore:
    def generate_plan(self, task: str, context: dict) -> dict:
        return {"task": task, "path": "STANDARD", "steps": []}
