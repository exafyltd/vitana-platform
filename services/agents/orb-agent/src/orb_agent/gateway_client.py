"""Thin async HTTP client for calling gateway endpoints from inside tool wrappers.

One-call pattern: every tool body in tools.py is a single
`await GatewayClient.post(...)` / `.get(...)`. The gateway is the source
of truth for tool behaviour; the agent only marshals the call.
"""
from __future__ import annotations

import logging
from typing import Any

import httpx

logger = logging.getLogger(__name__)

DEFAULT_TIMEOUT_S = 10.0
SLOW_TIMEOUT_S = 30.0  # for tools that may hit external APIs (search_web, consult_external_ai)


class GatewayClient:
    """Per-session HTTP client. Holds the user's JWT for ALL requests so the
    gateway can authenticate every tool call as the user, never as the agent."""

    def __init__(
        self,
        base_url: str,
        user_jwt: str | None,
        service_token: str | None = None,
        *,
        timeout_s: float = DEFAULT_TIMEOUT_S,
        user_id: str | None = None,
        tenant_id: str | None = None,
        active_role: str | None = None,
    ) -> None:
        self._base = base_url.rstrip("/")
        self._user_jwt = user_jwt
        self._service_token = service_token
        self._user_id = user_id
        self._tenant_id = tenant_id
        self._active_role = active_role
        self._client = httpx.AsyncClient(timeout=timeout_s)
        # The live LiveKit Room handle is stashed by session.py after the
        # AgentSession spins up. Tool wrappers that receive a structured
        # `directive` payload from the gateway use this to call
        # publish_orb_directive() and the data-channel listener on the
        # frontend handles the redirect / open-url. Optional — typed Any
        # here so unit tests on machines without livekit installed don't
        # need to import rtc just to construct a stub.
        self.room: Any = None

    def _headers(self) -> dict[str, str]:
        h = {"Content-Type": "application/json"}
        if self._user_jwt:
            h["Authorization"] = f"Bearer {self._user_jwt}"
        elif self._service_token:
            h["Authorization"] = f"Bearer {self._service_token}"
        # Defense-in-depth: some gateway routes still read X-User-ID /
        # X-Vitana-Active-Role / X-Tenant-ID rather than the JWT identity
        # (legacy middleware predates auth-supabase-jwt). Send them when we
        # have the values from room metadata so those routes also resolve
        # the right user.
        if self._user_id:
            h["X-User-ID"] = self._user_id
        if self._tenant_id:
            h["X-Tenant-ID"] = self._tenant_id
        if self._active_role:
            h["X-Vitana-Active-Role"] = self._active_role
        return h

    async def get(self, path: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        try:
            r = await self._client.get(self._base + path, params=params, headers=self._headers())
            return _to_dict(r)
        except Exception as exc:  # noqa: BLE001
            logger.warning("gateway GET %s failed: %s", path, exc)
            return {"ok": False, "error": str(exc), "transport": "exception"}

    async def post(self, path: str, body: dict[str, Any] | None = None) -> dict[str, Any]:
        try:
            r = await self._client.post(self._base + path, json=body or {}, headers=self._headers())
            return _to_dict(r)
        except Exception as exc:  # noqa: BLE001
            logger.warning("gateway POST %s failed: %s", path, exc)
            return {"ok": False, "error": str(exc), "transport": "exception"}

    async def put(self, path: str, body: dict[str, Any]) -> dict[str, Any]:
        try:
            r = await self._client.put(self._base + path, json=body, headers=self._headers())
            return _to_dict(r)
        except Exception as exc:  # noqa: BLE001
            logger.warning("gateway PUT %s failed: %s", path, exc)
            return {"ok": False, "error": str(exc), "transport": "exception"}

    async def delete(self, path: str) -> dict[str, Any]:
        try:
            r = await self._client.delete(self._base + path, headers=self._headers())
            return _to_dict(r)
        except Exception as exc:  # noqa: BLE001
            logger.warning("gateway DELETE %s failed: %s", path, exc)
            return {"ok": False, "error": str(exc), "transport": "exception"}

    async def aclose(self) -> None:
        await self._client.aclose()


def _to_dict(r: httpx.Response) -> dict[str, Any]:
    try:
        body = r.json()
    except Exception:  # noqa: BLE001
        body = {"raw": r.text[:1000]}
    body.setdefault("_status", r.status_code)
    return body


def summarize(body: dict[str, Any], *, limit_chars: int = 4000) -> str:
    """Render a gateway response into the string the LLM sees as the tool output.

    Strategy: if `body.text` or `body.summary` exists, use it. Otherwise
    return a compact JSON summary truncated to `limit_chars` (matches
    MAX_TOOL_RESPONSE_CHARS from orb-live.ts).
    """
    if isinstance(body.get("text"), str):
        return body["text"][:limit_chars]
    if isinstance(body.get("summary"), str):
        return body["summary"][:limit_chars]
    if body.get("ok") is False and body.get("error"):
        return f"[error] {body['error']}"
    import json

    try:
        s = json.dumps(body, ensure_ascii=False, default=str)
    except (TypeError, ValueError):
        s = repr(body)
    if len(s) > limit_chars:
        s = s[: limit_chars - 50] + "… [truncated]"
    return s
