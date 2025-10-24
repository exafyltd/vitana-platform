"""Worker-Core: Declared-steps-only execution."""
from dataclasses import dataclass

@dataclass
class WorkerCore:
    def execute(self, plan: dict, cil_packet: dict) -> dict:
        return {"plan_id": plan.get("id"), "facts": [], "plan_deviation": False}
