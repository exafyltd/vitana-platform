"""erp-bridge HTTP surface (VTID-03840).

Private service: only the gateway talks to it (shared token), never a
browser. Routes:

  GET  /alive                     liveness (no auth)
  GET  /ready                     config + vendored router present (no auth)
  GET  /v1/catalog                the allowlist, no secrets
  POST /v1/execute                run one allowlisted action for one tenant
  GET  /v1/receipts/{tenant}/{key}  replay a stored receipt
"""
from __future__ import annotations

import logging
import os
import secrets
import time
from typing import Any, Literal

from fastapi import Depends, FastAPI, Header, HTTPException, Request
from pydantic import BaseModel, Field, field_validator

from . import runner as _runner
from .catalog import CATALOG_VERSION, ERPCLAW_ADDONS_PIN, ERPCLAW_PIN, CatalogError, get_spec, public_catalog
from .config import ConfigError, Settings, Tenant, load_settings
from .idempotency import IdempotencyConflict, MemoryReceiptStore, PostgresReceiptStore, ReceiptStore, request_hash

log = logging.getLogger("erp-bridge")

_KEY_RE = r"^[A-Za-z0-9_.:\-]{8,128}$"
_TENANT_RE = r"^[A-Za-z0-9_\-]{1,64}$"
_ACTION_RE = r"^[a-z0-9\-]{2,64}$"


class Confirmation(BaseModel):
    granted: bool = False
    approval_id: str | None = Field(default=None, max_length=128)
    approved_by: str | None = Field(default=None, max_length=128)
    requested_by: str | None = Field(default=None, max_length=128)


class Actor(BaseModel):
    user_id: str = Field(max_length=128)
    channel: Literal["web", "chat", "voice", "system"] = "web"


class ExecuteRequest(BaseModel):
    tenant_id: str = Field(pattern=_TENANT_RE)
    action: str = Field(pattern=_ACTION_RE)
    idempotency_key: str = Field(pattern=_KEY_RE)
    params: dict[str, Any] = Field(default_factory=dict)
    actor: Actor
    confirmation: Confirmation = Field(default_factory=Confirmation)

    @field_validator("params")
    @classmethod
    def _bounded(cls, v: dict[str, Any]) -> dict[str, Any]:
        if len(v) > 64:
            raise ValueError("too many params")
        for k in v:
            if not isinstance(k, str) or len(k) > 64:
                raise ValueError("bad param name")
        return v


def create_app(settings: Settings | None = None, store_factory=None, run_fn=None) -> FastAPI:
    """App factory. Tests inject settings/store/runner; prod uses env + Postgres."""
    from contextlib import asynccontextmanager

    @asynccontextmanager
    async def _lifespan(app_: FastAPI):
        if app_.state.settings is None:
            app_.state.settings = load_settings()   # raises ConfigError -> process refuses to start
        yield

    app = FastAPI(title="erp-bridge", version=CATALOG_VERSION, docs_url=None, redoc_url=None,
                  openapi_url=None, lifespan=_lifespan)
    app.state.settings = settings
    app.state.stores: dict[str, ReceiptStore] = {}
    app.state.store_factory = store_factory or (lambda t: PostgresReceiptStore(t.db_url, lock_timeout_s=(settings.subprocess_timeout_s if settings else 60) + 30))
    app.state.run_fn = run_fn or _runner.run
    app.state.started = time.time()

    def _settings() -> Settings:
        s = app.state.settings
        if s is None:
            raise HTTPException(503, "not configured")
        return s

    def _auth(x_erp_bridge_token: str | None = Header(default=None)) -> None:
        s = _settings()
        if not x_erp_bridge_token or not secrets.compare_digest(x_erp_bridge_token, s.token):
            raise HTTPException(401, "invalid bridge token")

    def _tenant(tenant_id: str) -> Tenant:
        t = _settings().tenants.get(tenant_id)
        if t is None:
            raise HTTPException(404, "unknown tenant")
        return t

    def _store(t: Tenant) -> ReceiptStore:
        st = app.state.stores.get(t.tenant_id)
        if st is None:
            st = app.state.store_factory(t)
            app.state.stores[t.tenant_id] = st
        return st

    @app.get("/alive")
    def alive() -> dict[str, Any]:
        s = app.state.settings
        return {"ok": True, "service": "erp-bridge", "catalog": CATALOG_VERSION, "env": s.env if s else None,
                "erpclaw_pin": ERPCLAW_PIN[:12], "addons_pin": ERPCLAW_ADDONS_PIN[:12],
                "uptime_s": int(time.time() - app.state.started)}

    @app.get("/ready")
    def ready() -> dict[str, Any]:
        s = app.state.settings
        if s is None:
            raise HTTPException(503, "not configured")
        problems = []
        if not os.path.isfile(s.router_path):
            problems.append("erpclaw router missing")
        if not s.tenants:
            problems.append("no tenants configured")
        if problems:
            raise HTTPException(503, "; ".join(problems))
        return {"ok": True, "tenants": len(s.tenants)}

    @app.get("/v1/catalog", dependencies=[Depends(_auth)])
    def catalog() -> dict[str, Any]:
        return {"ok": True, "version": CATALOG_VERSION, "erpclaw_pin": ERPCLAW_PIN,
                "addons_pin": ERPCLAW_ADDONS_PIN, "actions": public_catalog()}

    @app.get("/v1/receipts/{tenant_id}/{key}", dependencies=[Depends(_auth)])
    def receipt(tenant_id: str, key: str) -> dict[str, Any]:
        t = _tenant(tenant_id)
        rec = _store(t).get(t.tenant_id, key)
        if rec is None:
            raise HTTPException(404, "no receipt")
        return {"ok": True, "receipt": _receipt_body(rec.status, rec.response, rec.idempotency_key, replayed=True)}

    @app.post("/v1/execute", dependencies=[Depends(_auth)])
    def execute(req: ExecuteRequest, request: Request) -> dict[str, Any]:
        s = _settings()
        t = _tenant(req.tenant_id)
        try:
            spec = get_spec(req.action)
        except CatalogError as exc:
            raise HTTPException(403, str(exc))
        if spec.module != "foundation" and spec.module not in s.module_allowlist:
            raise HTTPException(403, f"module {spec.module} is not enabled")
        confirmed = bool(req.confirmation.granted)
        if spec.requires_confirmation and not confirmed:
            raise HTTPException(403, {"error": "confirmation_required", "tier": spec.tier, "action": spec.name})
        if spec.tier == "high":
            c = req.confirmation
            if not c.approval_id or not c.approved_by or not c.requested_by:
                raise HTTPException(403, {"error": "approval_required", "tier": "high", "action": spec.name})
            if c.approved_by == c.requested_by:
                raise HTTPException(403, {"error": "maker_checker_violation", "action": spec.name})
            if req.actor.channel == "voice":
                raise HTTPException(403, {"error": "voice_cannot_confirm_high_risk", "action": spec.name})
        # Validate argv BEFORE touching the receipt store so a bad request never burns a key.
        try:
            _runner.build_argv(s, spec, t, req.params, confirmed and spec.dangerous)
        except _runner.RunnerError as exc:
            raise HTTPException(422, str(exc))
        rhash = request_hash(spec.name, req.params, confirmed)

        def _do() -> tuple[str, dict[str, Any]]:
            res = app.state.run_fn(s, spec, t, req.params, confirmed and spec.dangerous)
            ok = res.rc == 0 and not res.timed_out and isinstance(res.result, dict) and res.result.get("status") != "error"
            body = {
                "action": spec.name, "command": spec.command, "tier": spec.tier, "tenant_id": t.tenant_id,
                "rc": res.rc, "timed_out": res.timed_out, "duration_ms": res.duration_ms,
                "result": res.result, "stdout_tail": res.stdout_tail, "stderr_tail": res.stderr_tail,
                "argv": res.argv_public, "actor": req.actor.model_dump(),
                "confirmation": req.confirmation.model_dump(), "catalog_version": CATALOG_VERSION,
                "erpclaw_pin": ERPCLAW_PIN,
            }
            log.info("erp-bridge action=%s tenant=%s tier=%s rc=%s ms=%s", spec.name, t.tenant_id, spec.tier, res.rc, res.duration_ms)
            return ("executed" if ok else "failed"), body

        try:
            rec, replayed = _store(t).execute_once(t.tenant_id, req.idempotency_key, spec.name, rhash, _do,
                                                   stale_after_s=s.subprocess_timeout_s + 60)
        except IdempotencyConflict as exc:
            raise HTTPException(409, {"error": "idempotency_conflict", "reason": exc.reason})
        return {"ok": rec.status == "executed", "receipt": _receipt_body(rec.status, rec.response, rec.idempotency_key, replayed)}

    return app


def _receipt_body(status: str, response: dict[str, Any] | None, key: str, replayed: bool) -> dict[str, Any]:
    body = dict(response or {})
    body.update({"status": status, "idempotency_key": key, "replayed": replayed})
    return body


def build() -> FastAPI:
    """uvicorn entry: `uvicorn app.main:build --factory`."""
    try:
        return create_app(load_settings())
    except ConfigError as exc:
        raise SystemExit(f"erp-bridge refusing to start: {exc}")
