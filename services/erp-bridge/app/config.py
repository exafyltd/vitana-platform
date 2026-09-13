"""Environment-driven configuration for erp-bridge (VTID-03840).

Everything security-relevant is explicit here so a reviewer can read the
whole attack surface in one screen:

- ERP_BRIDGE_TOKEN      shared secret; every /v1 request must present it as
                        `X-ERP-Bridge-Token`. Missing token => the service
                        refuses to serve /v1 at all (no "open by default").
- ERP_TENANTS           JSON object {tenant_id: {"db_url": "postgresql://...",
                        "company_id": "<erpclaw company uuid>"}}. One ERPClaw
                        database per tenant; company_id is injected by the
                        bridge on every company-scoped action, never taken
                        from the request. Loaded once, never logged, never
                        echoed in any response.
- ERPCLAW_ROOT          the vendored, pinned ERPClaw checkout (router at
                        scripts/db_query.py).
- ERPCLAW_HOME          the install home (lib/, modules/, install-state)
                        the vendor step prepares at image build.
- ERP_BRIDGE_SUBPROCESS_TIMEOUT_S  hard wall-clock cap per CLI invocation.
- ERP_BRIDGE_MAX_OUTPUT_BYTES      cap on captured stdout/stderr.
- ERP_BRIDGE_MODULE_ALLOWLIST      expansion modules whose actions may be
                                   dispatched. Wave 1: erpclaw-growth (CRM
                                   domain only; the catalog does the
                                   per-action narrowing).
- ERP_BRIDGE_ENV        staging|production|test — surfaced on /alive only.
"""
from __future__ import annotations

import json
import os
from dataclasses import dataclass, field


class ConfigError(RuntimeError):
    pass


@dataclass(frozen=True)
class Tenant:
    tenant_id: str
    db_url: str = field(repr=False)
    company_id: str | None = None


@dataclass(frozen=True)
class Settings:
    token: str
    erpclaw_root: str
    erpclaw_home: str
    tenants: dict[str, Tenant] = field(repr=False)
    subprocess_timeout_s: float = 60.0
    max_output_bytes: int = 2_000_000
    module_allowlist: tuple[str, ...] = ("erpclaw-growth",)
    env: str = "staging"
    fx_api_host: str = ""

    @property
    def router_path(self) -> str:
        return os.path.join(self.erpclaw_root, "scripts", "db_query.py")


def _parse_tenants(raw: str) -> dict[str, Tenant]:
    if not raw:
        return {}
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ConfigError("ERP_TENANTS is not valid JSON") from exc
    if not isinstance(data, dict):
        raise ConfigError("ERP_TENANTS must be a JSON object {tenant_id: {db_url, company_id}}")
    out: dict[str, Tenant] = {}
    for tenant, cfg in data.items():
        if not isinstance(cfg, dict):
            raise ConfigError(f"tenant {tenant!r}: value must be an object")
        url = cfg.get("db_url")
        if not isinstance(url, str) or not url.startswith(("postgresql://", "postgres://")):
            raise ConfigError(f"tenant {tenant!r}: db_url must be a postgresql:// URL")
        company = cfg.get("company_id")
        if company is not None and not isinstance(company, str):
            raise ConfigError(f"tenant {tenant!r}: company_id must be a string")
        out[str(tenant)] = Tenant(tenant_id=str(tenant), db_url=url, company_id=company)
    return out


def load_settings(environ: dict[str, str] | None = None) -> Settings:
    env = os.environ if environ is None else environ
    token = env.get("ERP_BRIDGE_TOKEN", "")
    if len(token) < 32:
        raise ConfigError("ERP_BRIDGE_TOKEN must be set (>= 32 chars); the bridge never runs open")
    root = env.get("ERPCLAW_ROOT", "")
    if not root or not os.path.isfile(os.path.join(root, "scripts", "db_query.py")):
        raise ConfigError("ERPCLAW_ROOT must point at the vendored ERPClaw checkout")
    home = env.get("ERPCLAW_HOME", "")
    if not home:
        raise ConfigError("ERPCLAW_HOME must be set")
    allow = tuple(m for m in env.get("ERP_BRIDGE_MODULE_ALLOWLIST", "erpclaw-growth").split(",") if m)
    return Settings(
        token=token,
        erpclaw_root=root,
        erpclaw_home=home,
        tenants=_parse_tenants(env.get("ERP_TENANTS", "")),
        subprocess_timeout_s=float(env.get("ERP_BRIDGE_SUBPROCESS_TIMEOUT_S", "60")),
        max_output_bytes=int(env.get("ERP_BRIDGE_MAX_OUTPUT_BYTES", "2000000")),
        module_allowlist=allow,
        env=env.get("ERP_BRIDGE_ENV", "staging"),
        fx_api_host=env.get("ERP_BRIDGE_FX_API_HOST", ""),
    )
