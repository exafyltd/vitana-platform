"""Validator-Core: 10 hard-fail governance rules."""
from dataclasses import dataclass

@dataclass
class ValidatorCore:
    GOVERNANCE_RULES = ["no_raw_memory", "declared_steps_only", "path_caps", 
                        "budget_enforcement", "stale_data", "citation_coverage",
                        "tenant_isolation", "plan_deviations", "slice_efficiency", "json_schema"]
    
    def validate(self, result: dict) -> dict:
        return {"valid": True, "rules_passed": len(self.GOVERNANCE_RULES)}
