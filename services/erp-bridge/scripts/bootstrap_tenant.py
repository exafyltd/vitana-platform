#!/usr/bin/env python3
"""One-shot tenant bootstrap for the erp-bridge (VTID-03840).

Runs INSIDE the bridge image as an ECS RunTask (see
scripts/aws/setup-erp-bridge-staging.sh `bootstrap-tenant`), never from a
laptop: the ERPClaw Postgres is private to the VPC. It is the only place
that ever holds the Postgres *master* password, and only for the two DDL
statements below.

What it does, idempotently (safe to re-run):

  1. CREATE ROLE <db_role> LOGIN  (skipped when present)
     CREATE DATABASE <db_name> OWNER <db_role>  (skipped when present)
  2. ERPClaw on the tenant database, exactly the spike sequence
     (docs/validation/VTID-03840/commands.log):
       initialize-database → migrate --user-confirmed
       → install_module_local.py erpclaw-growth (vendored, no network)
       → setup-company (skipped when a company with the abbr exists)
       → setup-chart-of-accounts --template <coa>  (idempotent upstream)
       → seed-defaults
  3. Prints ONE line `BOOTSTRAP_RESULT {...json...}` with tenant_id,
     db_name, db_role, db_host, company_id. Never the passwords: the
     provisioning script already owns them and composes the ERP_TENANTS
     entry itself.

Environment (all set by the provisioning script on the RunTask):
  ERP_BOOTSTRAP_TENANT_ID        Vitana tenant UUID (the key in ERP_TENANTS)
  ERP_BOOTSTRAP_DB_HOST/PORT     the ERPClaw Postgres endpoint
  ERP_BOOTSTRAP_ADMIN_USER       master user (DDL only)
  ERP_BOOTSTRAP_ADMIN_PASSWORD   master password  (ECS secret, RDS-managed)
  ERP_BOOTSTRAP_DB_NAME          [a-z][a-z0-9_]{0,39}
  ERP_BOOTSTRAP_DB_ROLE          default: same as DB_NAME
  ERP_BOOTSTRAP_DB_PASSWORD      tenant role password (ECS secret)
  ERP_BOOTSTRAP_COMPANY_NAME / _ABBR / _CURRENCY / _COUNTRY / _FY_START_MONTH
  ERP_BOOTSTRAP_COA_TEMPLATE     default uae_ifrs
  ERP_BOOTSTRAP_SSLMODE          default require
  ERPCLAW_ROOT / ERPCLAW_HOME    from the image
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from urllib.parse import quote

IDENT = re.compile(r"^[a-z][a-z0-9_]{0,39}$")


def env(name: str, default: str | None = None) -> str:
    v = os.environ.get(name, default)
    if v is None or v == "":
        sys.exit(f"bootstrap: {name} is required")
    return v


def ident(name: str, value: str) -> str:
    if not IDENT.match(value):
        sys.exit(f"bootstrap: {name}={value!r} must match {IDENT.pattern}")
    return value


def pg_url(user: str, password: str, host: str, port: str, db: str, sslmode: str) -> str:
    return (f"postgresql://{quote(user, safe='')}:{quote(password, safe='')}"
            f"@{host}:{port}/{db}?sslmode={sslmode}")


def ensure_role_and_db(admin_url: str, db_name: str, db_role: str, db_password: str) -> dict:
    import psycopg2  # in the image (requirements.txt)
    from psycopg2 import sql

    out = {"role_created": False, "db_created": False}
    conn = psycopg2.connect(admin_url)
    conn.autocommit = True  # CREATE DATABASE cannot run inside a transaction
    try:
        cur = conn.cursor()
        cur.execute("SELECT 1 FROM pg_roles WHERE rolname = %s", (db_role,))
        if cur.fetchone() is None:
            cur.execute(sql.SQL("CREATE ROLE {} LOGIN PASSWORD %s").format(sql.Identifier(db_role)),
                        (db_password,))
            out["role_created"] = True
        else:
            # keep the stored password authoritative: the provisioning script
            # generated it and will write it into ERP_TENANTS.
            cur.execute(sql.SQL("ALTER ROLE {} WITH LOGIN PASSWORD %s").format(sql.Identifier(db_role)),
                        (db_password,))
        # RDS: the master user is not a superuser, so `CREATE DATABASE … OWNER x`
        # fails with `must be able to SET ROLE "x"` unless the master user is a
        # member of x. The grant therefore has to happen BEFORE the CREATE
        # DATABASE, not after it (the first staging bootstrap of VTID-03840
        # failed exactly there). Harmless when already granted.
        cur.execute(sql.SQL("GRANT {} TO CURRENT_USER").format(sql.Identifier(db_role)))
        cur.execute("SELECT 1 FROM pg_database WHERE datname = %s", (db_name,))
        if cur.fetchone() is None:
            cur.execute(sql.SQL("CREATE DATABASE {} OWNER {}").format(
                sql.Identifier(db_name), sql.Identifier(db_role)))
            out["db_created"] = True
    finally:
        conn.close()
    return out


def erpclaw_env(home: str, tenant_url: str) -> dict[str, str]:
    # Mirrors app/runner.py::_env_for — minimal, no inherited secrets.
    return {
        "PATH": os.environ.get("PATH", "/usr/local/bin:/usr/bin:/bin"),
        "HOME": home,
        "LANG": "C.UTF-8",
        "PYTHONDONTWRITEBYTECODE": "1",
        "PYTHONIOENCODING": "utf-8",
        "ERPCLAW_HOME": home,
        "ERPCLAW_DB_DIALECT": "postgresql",
        "ERPCLAW_DB_URL": tenant_url,
    }


def run_action(root: str, home: str, tenant_url: str, args: list[str], timeout: int = 600,
               tolerate_sqlite_verify: bool = False) -> dict:
    argv = [sys.executable, os.path.join(root, "scripts", "db_query.py"), *args]
    proc = subprocess.run(argv, cwd=root, env=erpclaw_env(home, tenant_url), capture_output=True,
                          text=True, timeout=timeout, stdin=subprocess.DEVNULL)
    shown = " ".join(a for a in args if not a.startswith("postgresql://"))
    print(f"[erpclaw] {shown} -> rc {proc.returncode}", flush=True)
    body = proc.stdout.strip()
    try:
        data = json.loads(body) if body else {}
    except json.JSONDecodeError:
        # initialize-database prints a human banner before its JSON
        tail = body[body.rfind("{"):] if "{" in body else ""
        try:
            data = json.loads(tail) if tail else {}
        except json.JSONDecodeError:
            data = {"raw": body[-800:]}
    banner = body + "\n" + (proc.stderr or "")  # the init banner goes to stderr
    if tolerate_sqlite_verify and "initialized successfully" in banner and "Backend: PostgreSQL" in banner:
        # upstream initialize-database creates the Postgres schema, then verifies via
        # sqlite3 on DEFAULT_DB_PATH (SQLite-only code) and reports that failure as
        # the JSON body. The schema is there; the trailing error is the verify step.
        print("[erpclaw] initialize-database: Postgres schema created (sqlite verify step ignored)", flush=True)
        return {"status": "ok", "backend": "postgresql"}
    if proc.returncode != 0 and data.get("status") != "ok":
        sys.exit(f"bootstrap: ERPClaw action failed: {shown}\n{body[-1500:]}\n{proc.stderr[-1500:]}")
    if isinstance(data, dict) and data.get("status") == "error":
        sys.exit(f"bootstrap: ERPClaw action returned error: {shown}\n{json.dumps(data)[:1500]}")
    return data


def install_growth(root: str, home: str, tenant_url: str) -> dict:
    src = os.path.join(home, "vendored-modules", "erpclaw-growth")
    if not os.path.isdir(src):
        sys.exit(f"bootstrap: vendored module tree missing: {src} (vendor.sh did not stage it)")
    e = erpclaw_env(home, tenant_url)
    e["ERPCLAW_ROOT"] = root
    vendor_dir = os.environ.get("ERP_BRIDGE_VENDOR_DIR", "/app/vendor")
    proc = subprocess.run([sys.executable, os.path.join(vendor_dir, "install_module_local.py"), "erpclaw-growth", src],
                          cwd=root, env=e, capture_output=True, text=True, timeout=600,
                          stdin=subprocess.DEVNULL)
    print(f"[module] install erpclaw-growth -> rc {proc.returncode}", flush=True)
    if proc.returncode != 0:
        sys.exit(f"bootstrap: module install failed\n{proc.stdout[-1500:]}\n{proc.stderr[-1500:]}")
    last = [ln for ln in proc.stdout.splitlines() if ln.startswith("{")]
    try:
        return json.loads(last[-1]) if last else {}
    except json.JSONDecodeError:
        return {}


def find_company(root: str, home: str, tenant_url: str, abbr: str) -> str | None:
    data = run_action(root, home, tenant_url, ["--action", "list-companies"])
    rows = data.get("companies") if isinstance(data, dict) else None
    for row in rows or []:
        if str(row.get("abbr", "")).upper() == abbr.upper():
            return str(row.get("id"))
    return None


def main() -> int:
    tenant_id = env("ERP_BOOTSTRAP_TENANT_ID")
    host = env("ERP_BOOTSTRAP_DB_HOST")
    port = env("ERP_BOOTSTRAP_DB_PORT", "5432")
    admin_user = env("ERP_BOOTSTRAP_ADMIN_USER")
    admin_password = env("ERP_BOOTSTRAP_ADMIN_PASSWORD")
    db_name = ident("ERP_BOOTSTRAP_DB_NAME", env("ERP_BOOTSTRAP_DB_NAME"))
    db_role = ident("ERP_BOOTSTRAP_DB_ROLE", env("ERP_BOOTSTRAP_DB_ROLE", db_name))
    db_password = env("ERP_BOOTSTRAP_DB_PASSWORD")
    sslmode = env("ERP_BOOTSTRAP_SSLMODE", "require")
    company_name = env("ERP_BOOTSTRAP_COMPANY_NAME")
    abbr = env("ERP_BOOTSTRAP_COMPANY_ABBR")
    currency = env("ERP_BOOTSTRAP_COMPANY_CURRENCY", "AED")
    country = env("ERP_BOOTSTRAP_COMPANY_COUNTRY", "United Arab Emirates")
    fy_month = env("ERP_BOOTSTRAP_FY_START_MONTH", "1")
    coa = env("ERP_BOOTSTRAP_COA_TEMPLATE", "uae_ifrs")
    root = env("ERPCLAW_ROOT", "/opt/erpclaw")
    home = env("ERPCLAW_HOME", "/var/lib/erpclaw")
    if len(db_password) < 24:
        sys.exit("bootstrap: ERP_BOOTSTRAP_DB_PASSWORD must be >= 24 chars")

    admin_url = pg_url(admin_user, admin_password, host, port, "postgres", sslmode)
    ddl = ensure_role_and_db(admin_url, db_name, db_role, db_password)
    print(f"[ddl] {json.dumps(ddl)}", flush=True)

    tenant_url = pg_url(db_role, db_password, host, port, db_name, sslmode)
    run_action(root, home, tenant_url, ["--action", "initialize-database"], tolerate_sqlite_verify=True)
    # initialize-database's post-check opens DEFAULT_DB_PATH with sqlite3 directly
    # (upstream, SQLite-only) and leaves an EMPTY data.sqlite in ERPCLAW_HOME. The
    # migration runner would then target that file instead of Postgres
    # ("near SET: syntax error" — seen in the local rehearsal). Remove it.
    stray = os.path.join(home, "data.sqlite")
    if os.path.isfile(stray) and os.path.getsize(stray) == 0:
        os.remove(stray)
        print("[cleanup] removed empty data.sqlite left by initialize-database", flush=True)
    run_action(root, home, tenant_url, ["--action", "migrate", "--user-confirmed"])
    module = install_growth(root, home, tenant_url)

    company_id = find_company(root, home, tenant_url, abbr)
    created = False
    if company_id is None:
        data = run_action(root, home, tenant_url, [
            "--action", "setup-company", "--name", company_name, "--abbr", abbr,
            "--currency", currency, "--country", country, "--fiscal-year-start-month", fy_month,
            "--user-confirmed"])
        company_id = str(data.get("company_id") or (data.get("company") or {}).get("id") or "")
        if not company_id:
            company_id = find_company(root, home, tenant_url, abbr) or ""
        created = bool(company_id)
    if not company_id:
        sys.exit("bootstrap: could not determine company_id after setup-company")
    coa_res = run_action(root, home, tenant_url, [
        "--action", "setup-chart-of-accounts", "--company-id", company_id, "--template", coa])
    run_action(root, home, tenant_url, ["--action", "seed-defaults", "--company-id", company_id])

    result = {
        "tenant_id": tenant_id, "db_name": db_name, "db_role": db_role,
        "db_host": host, "db_port": int(port), "sslmode": sslmode,
        "company_id": company_id, "company_created": created,
        "coa_template": coa, "accounts_created": coa_res.get("accounts_created"),
        "module": module.get("module"), "module_version": module.get("version"),
        **ddl,
    }
    print("BOOTSTRAP_RESULT " + json.dumps(result, sort_keys=True), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
