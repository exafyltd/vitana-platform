"""
LLM Provider Router with Fallback Logic
Handles routing between Gemini, OpenAI, Claude, and Grok with timeouts and retries
"""

import os
import json
import time
import asyncio
from typing import Any, Dict, Optional, List, Tuple
from dataclasses import dataclass
from enum import Enum
import logging

import httpx
import google.auth
from google.cloud import secretmanager

logger = logging.getLogger(__name__)


class LLMProvider(Enum):
    GEMINI = "gemini"
    OPENAI = "openai"
    CLAUDE = "claude"
    GROK = "grok"


@dataclass
class LLMRoute:
    """Represents a routing priority for a specific role/task"""
    role: str  # planner, worker, validator
    primary: LLMProvider
    secondary: LLMProvider
    tertiary: LLMProvider
    fallback: LLMProvider
    timeout_ms: int


# Default routing table
DEFAULT_ROUTES = {
    "planner": LLMRoute(
        role="planner",
        primary=LLMProvider.GEMINI,
        secondary=LLMProvider.CLAUDE,
        tertiary=LLMProvider.OPENAI,
        fallback=LLMProvider.GROK,
        timeout_ms=500
    ),
    "worker": LLMRoute(
        role="worker",
        primary=LLMProvider.GEMINI,
        secondary=LLMProvider.OPENAI,
        tertiary=LLMProvider.CLAUDE,
        fallback=LLMProvider.GROK,
        timeout_ms=5000
    ),
    "validator": LLMRoute(
        role="validator",
        primary=LLMProvider.GEMINI,
        secondary=LLMProvider.CLAUDE,
        tertiary=LLMProvider.OPENAI,
        fallback=LLMProvider.GROK,
        timeout_ms=3000
    ),
}


class SecretManager:
    """Handles fetching API keys from GCP Secret Manager"""
    
    def __init__(self, project_id: str):
        self.project_id = project_id
        self.client = secretmanager.SecretManagerServiceClient()
        self._cache = {}
    
    def get_secret(self, secret_name: str) -> str:
        """Fetch secret from Secret Manager with caching"""
        if secret_name in self._cache:
            return self._cache[secret_name]
        
        name = f"projects/{self.project_id}/secrets/{secret_name}/versions/latest"
        response = self.client.access_secret_version(request={"name": name})
        secret_value = response.payload.data.decode('UTF-8')
        self._cache[secret_name] = secret_value
        return secret_value


class LLMRouter:
    """Routes LLM calls with fallback logic and timeout handling"""
    
    def __init__(self, project_id: str, routes: Dict[str, LLMRoute] = None):
        self.project_id = project_id
        self.routes = routes or DEFAULT_ROUTES
        self.secrets = SecretManager(project_id)
        self.call_log = []
    
    async def invoke(
        self,
        role: str,
        prompt: str,
        schema: Optional[Dict] = None,
        model_override: Optional[LLMProvider] = None,
    ) -> Tuple[str, LLMProvider, float, bool]:
        """Invoke an LLM with fallback logic"""
        
        route = self.routes.get(role, self.routes["worker"])
        providers_to_try = [
            model_override,
        ] if model_override else [
            route.primary,
            route.secondary,
            route.tertiary,
            route.fallback,
        ]
        
        for provider in providers_to_try:
            if provider is None:
                continue
            
            try:
                start_time = time.time()
                response, latency = await self._call_provider(
                    provider=provider,
                    prompt=prompt,
                    schema=schema,
                    timeout_ms=route.timeout_ms,
                )
                elapsed = time.time() - start_time
                latency_ms = elapsed * 1000
                
                self._log_call(role, provider, latency_ms, success=True, schema=schema)
                return response, provider, latency_ms, True
            
            except asyncio.TimeoutError:
                logger.warning(f"{provider.value} timed out for {role}, trying next...")
                self._log_call(role, provider, route.timeout_ms, success=False, error="timeout")
                continue
            
            except Exception as e:
                logger.error(f"{provider.value} failed for {role}: {str(e)}")
                self._log_call(role, provider, 0, success=False, error=str(e))
                continue
        
        raise Exception(f"All LLM providers exhausted for role={role}")
    
    async def _call_provider(
        self,
        provider: LLMProvider,
        prompt: str,
        schema: Optional[Dict],
        timeout_ms: int,
    ) -> Tuple[str, float]:
        """Call a specific provider with timeout"""
        
        timeout_sec = timeout_ms / 1000.0
        
        if provider == LLMProvider.GEMINI:
            return await self._call_gemini(prompt, schema, timeout_sec)
        elif provider == LLMProvider.OPENAI:
            return await self._call_openai(prompt, schema, timeout_sec)
        elif provider == LLMProvider.CLAUDE:
            return await self._call_claude(prompt, schema, timeout_sec)
        elif provider == LLMProvider.GROK:
            return await self._call_grok(prompt, schema, timeout_sec)
        else:
            raise ValueError(f"Unknown provider: {provider}")
    
    async def _call_gemini(self, prompt: str, schema: Optional[Dict], timeout: float) -> Tuple[str, float]:
        start = time.time()
        api_key = self.secrets.get_secret("LLM_GEMINI_API_KEY")
        
        async with httpx.AsyncClient(timeout=timeout) as client:
            url = f"https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent"
            headers = {"Content-Type": "application/json"}
            payload = {
                "contents": [{
                    "parts": [{"text": prompt}]
                }]
            }
            
            params = {"key": api_key}
            response = await client.post(url, json=payload, params=params, headers=headers)
            response.raise_for_status()
            
            data = response.json()
            text = data["candidates"][0]["content"]["parts"][0]["text"]
            latency = time.time() - start
            
            return text, latency
    
    async def _call_openai(self, prompt: str, schema: Optional[Dict], timeout: float) -> Tuple[str, float]:
        start = time.time()
        api_key = self.secrets.get_secret("LLM_OPENAI_API_KEY")
        
        async with httpx.AsyncClient(timeout=timeout) as client:
            url = "https://api.openai.com/v1/chat/completions"
            headers = {
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json"
            }
            payload = {
                "model": "gpt-4o",
                "messages": [{"role": "user", "content": prompt}],
                "max_tokens": 4096,
            }
            
            response = await client.post(url, json=payload, headers=headers)
            response.raise_for_status()
            
            data = response.json()
            text = data["choices"][0]["message"]["content"]
            latency = time.time() - start
            
            return text, latency
    
    async def _call_claude(self, prompt: str, schema: Optional[Dict], timeout: float) -> Tuple[str, float]:
        start = time.time()
        api_key = self.secrets.get_secret("LLM_CLAUDE_API_KEY")
        
        async with httpx.AsyncClient(timeout=timeout) as client:
            url = "https://api.anthropic.com/v1/messages"
            headers = {
                "x-api-key": api_key,
                "Content-Type": "application/json",
                "anthropic-version": "2023-06-01"
            }
            payload = {
                "model": "claude-haiku-4-5-20251001",
                "max_tokens": 4096,
                "messages": [{"role": "user", "content": prompt}]
            }
            
            response = await client.post(url, json=payload, headers=headers)
            response.raise_for_status()
            
            data = response.json()
            text = data["content"][0]["text"]
            latency = time.time() - start
            
            return text, latency
    
    async def _call_grok(self, prompt: str, schema: Optional[Dict], timeout: float) -> Tuple[str, float]:
        start = time.time()
        api_key = self.secrets.get_secret("LLM_GROK_API_KEY")
        
        async with httpx.AsyncClient(timeout=timeout) as client:
            url = "https://api.x.ai/v1/chat/completions"
            headers = {
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json"
            }
            payload = {
                "model": "grok-2",
                "messages": [{"role": "user", "content": prompt}],
                "max_tokens": 4096,
            }
            
            response = await client.post(url, json=payload, headers=headers)
            response.raise_for_status()
            
            data = response.json()
            text = data["choices"][0]["message"]["content"]
            latency = time.time() - start
            
            return text, latency
    
    def _log_call(self, role: str, provider: LLMProvider, latency_ms: float, success: bool, **kwargs):
        log_entry = {
            "timestamp": time.time(),
            "role": role,
            "provider": provider.value,
            "latency_ms": latency_ms,
            "success": success,
            **kwargs
        }
        self.call_log.append(log_entry)


def invoke_sync(
    role: str,
    prompt: str,
    project_id: str,
    schema: Optional[Dict] = None,
    model_override: Optional[LLMProvider] = None,
) -> Tuple[str, LLMProvider, float, bool]:
    """Synchronous wrapper around async invoke"""
    router = LLMRouter(project_id)
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    try:
        result = loop.run_until_complete(
            router.invoke(role, prompt, schema, model_override)
        )
        return result
    finally:
        loop.close()
