"""Subprocess runner for the vendored ERPClaw CLI (VTID-03840).

Security shape (brief §8, GOLDEN-WORKFLOWS §4.1):

- argv is built ONLY from the catalog spec: `--action <name>` plus one
  `--flag value` per parameter the spec admits. Nothing else is ever
  appended. In particular `--user-confirmed` is appended by the bridge, and
  only when the spec is ERPClaw-gated AND the caller carries an admitted
  confirmation — never from a payload field.
- `--company-id` is injected from tenant config for company-scoped actions;
  a request cannot name a company.
- No shell. Fixed interpreter, fixed router path, fixed cwd. Minimal env:
  the tenant's DB URL and ERPClaw's home/dialect, nothing inherited.
- Hard timeout, bounded output, and the DB URL (with any password) is
  redacted from everything that leaves this module.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import urlsplit

from .catalog import ActionSpec, CatalogError, admitted_flag
from .config import Settings, Tenant


class RunnerError(ValueError):
    """A request that must not reach the subprocess at all."""


@dataclass(frozen=True)
class RunResult:
    rc: int
    duration_ms: int
    timed_out: bool
    result: Any                      # parsed JSON stdout, or None
    stdout_tail: str                 # redacted, bounded (only when not JSON)
    stderr_tail: str                 # redacted, bounded
    argv_public: list[str] = field(default_factory=list)  # for receipts/audit


_JSON_PARAM_TYPES = (list, dict)


def _flag_value(name: str, value: Any) -> str:
    if isinstance(value, bool):
        raise RunnerError(f"param {name!r}: boolean given for a value flag")
    if isinstance(value, _JSON_PARAM_TYPES):
        return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
    if isinstance(value, (int, float)):
        return repr(value) if isinstance(value, float) else str(value)
    if isinstance(value, str):
        if "\x00" in value:
            raise RunnerError(f"param {name!r}: NUL byte")
        if value.startswith("-"):
            # argparse would read a leading-dash value as another flag.
            raise RunnerError(f"param {name!r}: value may not start with '-'")
        return value
    raise RunnerError(f"param {name!r}: unsupported type {type(value).__name__}")


def build_argv(settings: Settings, spec: ActionSpec, tenant: Tenant,
               params: dict[str, Any], confirmed: bool) -> list[str]:
    argv = [sys.executable, settings.router_path, "--action", spec.name]
    if spec.company_scoped:
        if not tenant.company_id:
            raise RunnerError("tenant has no company_id configured; company-scoped action refused")
        argv += ["--company-id", tenant.company_id]
    for name in sorted(params):
        try:
            flag, store_true = admitted_flag(spec, name)
        except CatalogError as exc:
            raise RunnerError(str(exc)) from exc
        value = params[name]
        if store_true:
            if value is True:
                argv.append(flag)
            elif value is False or value is None:
                continue
            else:
                raise RunnerError(f"param {name!r}: switch flag takes true/false only")
            continue
        if value is None:
            continue
        argv += [flag, _flag_value(name, value)]
    if spec.dangerous and confirmed:
        argv.append("--user-confirmed")
    return argv


def _redactor(tenant: Tenant):
    parts = urlsplit(tenant.db_url)
    secrets = [tenant.db_url]
    if parts.password:
        secrets.append(parts.password)
    if parts.netloc:
        secrets.append(parts.netloc)
    if parts.hostname:
        secrets.append(parts.hostname)
    # longest first so the full URL/netloc go before a bare hostname
    secrets.sort(key=len, reverse=True)

    def redact(text: str) -> str:
        for s in secrets:
            if s:
                text = text.replace(s, "<redacted>")
        return text
    return redact


def _env_for(settings: Settings, tenant: Tenant) -> dict[str, str]:
    return {
        "PATH": os.environ.get("PATH", "/usr/local/bin:/usr/bin:/bin"),
        "HOME": settings.erpclaw_home,
        "LANG": "C.UTF-8",
        "PYTHONDONTWRITEBYTECODE": "1",
        "PYTHONIOENCODING": "utf-8",
        "ERPCLAW_HOME": settings.erpclaw_home,
        "ERPCLAW_DB_DIALECT": "postgresql",
        "ERPCLAW_DB_URL": tenant.db_url,
    }


def run(settings: Settings, spec: ActionSpec, tenant: Tenant,
        params: dict[str, Any], confirmed: bool) -> RunResult:
    argv = build_argv(settings, spec, tenant, params, confirmed)
    redact = _redactor(tenant)
    started = time.perf_counter()
    timed_out = False
    try:
        proc = subprocess.run(
            argv,
            cwd=settings.erpclaw_root,
            env=_env_for(settings, tenant),
            capture_output=True,
            timeout=settings.subprocess_timeout_s,
            shell=False,
            stdin=subprocess.DEVNULL,
        )
        rc, out, err = proc.returncode, proc.stdout, proc.stderr
    except subprocess.TimeoutExpired as exc:
        timed_out = True
        rc, out, err = -1, exc.stdout or b"", exc.stderr or b""
    duration_ms = int((time.perf_counter() - started) * 1000)
    cap = settings.max_output_bytes
    out_s = out[:cap].decode("utf-8", "replace")
    err_s = redact(err[-4000:].decode("utf-8", "replace"))
    result = None
    stdout_tail = ""
    try:
        result = json.loads(out_s) if out_s.strip() else None
    except json.JSONDecodeError:
        stdout_tail = redact(out_s[-2000:])
    if isinstance(result, dict):
        # Defensive: never let a DB URL that leaked into an ERPClaw error
        # message travel further.
        result = json.loads(redact(json.dumps(result)))
    return RunResult(
        rc=rc, duration_ms=duration_ms, timed_out=timed_out, result=result,
        stdout_tail=stdout_tail, stderr_tail=err_s,
        argv_public=[a for a in argv[3:]],  # drop interpreter + router path
    )
