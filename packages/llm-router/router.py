"""
Centralized LLM Router for Vitana Platform
Routes LLM requests based on agent role with fallback support and cost optimization.
"""

import os
import time
import uuid
from typing import Optional, Dict, Any
from enum import Enum
import requests

class AgentRole(Enum):
    """Agent roles with specific routing policies"""
    PLANNER = "planner"
    WORKER = "worker"
    VALIDATOR = "validator"

class LLMRouter:
    """Centralized router for all LLM calls"""
    
    ROUTING_POLICY = {
        AgentRole.PLANNER: {
            "primary": {"provider": "anthropic", "model": "claude-3-5-sonnet-20241022"},
            "fallback": {"provider": "vertex_ai", "model": "gemini-1.5-pro"}
        },
        AgentRole.WORKER: {
            "primary": {"provider": "vertex_ai", "model": "gemini-1.5-flash"},
            "fallback": {"provider": "vertex_ai", "model": "gemini-1.5-pro"}
        },
        AgentRole.VALIDATOR: {
            "primary": {"provider": "anthropic", "model": "claude-3-5-sonnet-20241022"},
            "fallback": {"provider": "vertex_ai", "model": "gemini-1.5-pro"}
        }
    }
    
    def __init__(self):
        self.oasis_url = os.getenv("OASIS_GATEWAY_URL", "https://oasis-gateway.vitana.ai")
        self.anthropic_key = os.getenv("ANTHROPIC_API_KEY")
        self.project_id = os.getenv("GCP_PROJECT_ID", "lovable-vitana-vers1")
    
    def complete(self, role: AgentRole, prompt: str, max_tokens: int = 4000, 
                 temperature: float = 0.7, metadata: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """Route LLM request based on agent role"""
        start_time = time.time()
        request_id = str(uuid.uuid4())
        
        policy = self.ROUTING_POLICY[role]
        
        try:
            result = self._call_llm(
                provider=policy["primary"]["provider"],
                model=policy["primary"]["model"],
                prompt=prompt,
                max_tokens=max_tokens,
                temperature=temperature
            )
            result["fallback_used"] = False
        except Exception as primary_error:
            print(f"⚠️ Primary model failed: {primary_error}")
            try:
                result = self._call_llm(
                    provider=policy["fallback"]["provider"],
                    model=policy["fallback"]["model"],
                    prompt=prompt,
                    max_tokens=max_tokens,
                    temperature=temperature
                )
                result["fallback_used"] = True
            except Exception as fallback_error:
                raise Exception(f"Both models failed: {fallback_error}")
        
        result["latency_ms"] = int((time.time() - start_time) * 1000)
        result["request_id"] = request_id
        result["role"] = role.value
        
        oasis_event_id = self._log_to_oasis("llm_call", {**result, "metadata": metadata})
        result["oasis_event_id"] = oasis_event_id
        
        return result
    
    def _call_llm(self, provider: str, model: str, prompt: str, 
                  max_tokens: int, temperature: float) -> Dict[str, Any]:
        """Call specific LLM provider"""
        if provider == "anthropic":
            return self._call_anthropic(model, prompt, max_tokens, temperature)
        elif provider == "vertex_ai":
            return self._call_vertex(model, prompt, max_tokens, temperature)
        else:
            raise ValueError(f"Unknown provider: {provider}")
    
    def _call_anthropic(self, model: str, prompt: str, max_tokens: int, temperature: float) -> Dict[str, Any]:
        """Call Anthropic Claude API"""
        try:
            from anthropic import Anthropic
        except ImportError:
            raise Exception("anthropic package not installed")
        
        client = Anthropic(api_key=self.anthropic_key)
        response = client.messages.create(
            model=model,
            max_tokens=max_tokens,
            temperature=temperature,
            messages=[{"role": "user", "content": prompt}]
        )
        
        input_tokens = response.usage.input_tokens
        output_tokens = response.usage.output_tokens
        cost = (input_tokens * 3 / 1_000_000) + (output_tokens * 15 / 1_000_000)
        
        return {
            "text": response.content[0].text,
            "model": model,
            "provider": "anthropic",
            "tokens": {"input": input_tokens, "output": output_tokens, "total": input_tokens + output_tokens},
            "cost_usd": round(cost, 6)
        }
    
    def _call_vertex(self, model: str, prompt: str, max_tokens: int, temperature: float) -> Dict[str, Any]:
        """Call Google Vertex AI"""
        try:
            from vertexai.preview.generative_models import GenerativeModel
            import vertexai
        except ImportError:
            raise Exception("vertexai package not installed")
        
        vertexai.init(project=self.project_id, location="us-central1")
        model_obj = GenerativeModel(model)
        response = model_obj.generate_content(prompt)
        
        # Approximate token counts and costs
        input_tokens = len(prompt.split()) * 1.3
        output_tokens = len(response.text.split()) * 1.3
        
        if "flash" in model.lower():
            cost = (input_tokens * 0.075 / 1_000_000) + (output_tokens * 0.30 / 1_000_000)
        else:
            cost = (input_tokens * 1.25 / 1_000_000) + (output_tokens * 5 / 1_000_000)
        
        return {
            "text": response.text,
            "model": model,
            "provider": "vertex_ai",
            "tokens": {"input": int(input_tokens), "output": int(output_tokens), "total": int(input_tokens + output_tokens)},
            "cost_usd": round(cost, 6)
        }
    
    def _log_to_oasis(self, event_type: str, data: Dict[str, Any]) -> str:
        """Log event to OASIS gateway"""
        event_id = str(uuid.uuid4())
        try:
            requests.post(
                f"{self.oasis_url}/events",
                json={"event_id": event_id, "event_type": event_type, "timestamp": time.time(), "data": data},
                timeout=5
            )
        except Exception as e:
            print(f"⚠️ OASIS logging error: {e}")
        return event_id

_router_instance = None

def get_router() -> LLMRouter:
    """Get singleton router instance"""
    global _router_instance
    if _router_instance is None:
        _router_instance = LLMRouter()
    return _router_instance
