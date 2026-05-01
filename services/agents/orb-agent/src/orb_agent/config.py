"""Environment-variable resolution + LiveKit / Gateway configuration."""
from __future__ import annotations

import os
from dataclasses import dataclass


@dataclass(frozen=True)
class AgentConfig:
    """Resolved configuration for the orb-agent process."""

    livekit_url: str
    livekit_api_key: str
    livekit_api_secret: str
    gateway_url: str
    gateway_service_token: str
    log_level: str = "INFO"
    max_tool_steps: int = 5
    max_reconnects: int = 10
    health_port: int = 8080
    heartbeat_interval_seconds: int = 60

    @classmethod
    def from_env(cls) -> "AgentConfig":
        return cls(
            livekit_url=_required("LIVEKIT_URL"),
            livekit_api_key=_required("LIVEKIT_API_KEY"),
            livekit_api_secret=_required("LIVEKIT_API_SECRET"),
            gateway_url=_required("GATEWAY_URL"),
            gateway_service_token=_required("GATEWAY_SERVICE_TOKEN"),
            log_level=os.getenv("AGENT_LOG_LEVEL", "INFO"),
            max_tool_steps=int(os.getenv("AGENT_MAX_TOOL_STEPS", "5")),
            max_reconnects=int(os.getenv("AGENT_MAX_RECONNECTS", "10")),
            health_port=int(os.getenv("PORT", "8080")),
            heartbeat_interval_seconds=int(os.getenv("AGENT_HEARTBEAT_S", "60")),
        )


def _required(name: str) -> str:
    value = os.getenv(name)
    if not value:
        raise RuntimeError(
            f"Missing required environment variable {name}. "
            "See services/agents/orb-agent/manifest.json for the full required-env list."
        )
    return value
