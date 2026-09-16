"""VTID-03840 — pure parts of scripts/bootstrap_tenant.py.

The end-to-end path (role + database DDL, initialize-database, migrate,
module install, company, CoA, seed) is rehearsed against a real Postgres in
docs/validation/VTID-03840/outputs/18-tenant-bootstrap-rehearsal.txt; these
tests pin the pieces that must never regress silently: identifier validation
(what ends up in CREATE ROLE / CREATE DATABASE), URL composition (password
quoting) and the minimal subprocess env (no inherited secrets).
"""
import importlib.util
import os
import subprocess
import sys

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, "..", "scripts", "bootstrap_tenant.py")


@pytest.fixture(scope="module")
def boot():
    spec = importlib.util.spec_from_file_location("bootstrap_tenant", SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


@pytest.mark.parametrize("value", ["erpclaw_vitanaland", "e", "a1_b2", "x" * 40])
def test_identifiers_that_are_safe_for_create_database(boot, value):
    assert boot.ident("ERP_BOOTSTRAP_DB_NAME", value) == value


@pytest.mark.parametrize("value", ["", "Erpclaw", "1abc", "a-b", "a b", "a;drop", 'a"b', "x" * 41, "postgres;"])
def test_identifiers_that_must_be_refused(boot, value):
    with pytest.raises(SystemExit):
        boot.ident("ERP_BOOTSTRAP_DB_NAME", value)


def test_pg_url_quotes_user_and_password_and_keeps_sslmode(boot):
    url = boot.pg_url("erp claw", "p@ss/w:rd?x=1", "db.internal", "5432", "erpclaw_t", "require")
    assert url == "postgresql://erp%20claw:p%40ss%2Fw%3Ard%3Fx%3D1@db.internal:5432/erpclaw_t?sslmode=require"


def test_erpclaw_env_is_minimal_and_carries_only_the_tenant_url(boot, monkeypatch):
    monkeypatch.setenv("ERP_BOOTSTRAP_ADMIN_PASSWORD", "master-secret")
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "leak")
    env = boot.erpclaw_env("/var/lib/erpclaw", "postgresql://t:pw@h:5432/d")
    assert set(env) == {"PATH", "HOME", "LANG", "PYTHONDONTWRITEBYTECODE", "PYTHONIOENCODING",
                        "ERPCLAW_HOME", "ERPCLAW_DB_DIALECT", "ERPCLAW_DB_URL"}
    assert env["ERPCLAW_DB_DIALECT"] == "postgresql"
    assert env["ERPCLAW_DB_URL"] == "postgresql://t:pw@h:5432/d"
    assert "master-secret" not in " ".join(env.values())


def test_missing_required_env_exits_before_any_ddl(boot, monkeypatch):
    for k in list(os.environ):
        if k.startswith("ERP_BOOTSTRAP_"):
            monkeypatch.delenv(k)
    with pytest.raises(SystemExit) as exc:
        boot.main()
    assert "ERP_BOOTSTRAP_TENANT_ID" in str(exc.value)


def test_script_compiles_and_prints_nothing_secret_on_usage_error():
    proc = subprocess.run([sys.executable, SCRIPT], capture_output=True, text=True,
                          env={"PATH": os.environ.get("PATH", ""), "ERP_BOOTSTRAP_TENANT_ID": ""}, timeout=30)
    assert proc.returncode != 0
    assert "is required" in (proc.stderr + proc.stdout)


def test_master_user_joins_owner_role_before_create_database(boot, monkeypatch):
    """RDS: the master user is not a superuser. `CREATE DATABASE … OWNER x`
    raises `must be able to SET ROLE "x"` unless the master user already
    belongs to x — the first staging bootstrap failed exactly there because
    the GRANT ran after the CREATE. Pin the order with a fake psycopg2."""
    import types

    executed: list[str] = []

    class _Cur:
        def execute(self, q, params=None):
            executed.append(str(q))

        def fetchone(self):
            return None  # role and database both absent

    class _Conn:
        autocommit = False

        def cursor(self):
            return _Cur()

        def close(self):
            pass

    class _SQL(str):
        def format(self, *parts):
            return _SQL(str.format(self, *(str(p) for p in parts)))

    fake_pg = types.ModuleType("psycopg2")
    fake_pg.connect = lambda url: _Conn()
    fake_sql = types.ModuleType("psycopg2.sql")
    fake_sql.SQL = _SQL
    fake_sql.Identifier = lambda name: f'"{name}"'
    fake_pg.sql = fake_sql
    monkeypatch.setitem(sys.modules, "psycopg2", fake_pg)
    monkeypatch.setitem(sys.modules, "psycopg2.sql", fake_sql)

    out = boot.ensure_role_and_db("postgresql://admin:pw@h:5432/postgres", "erpclaw_t", "erpclaw_t", "pw")

    assert out == {"role_created": True, "db_created": True}
    grant = next(i for i, q in enumerate(executed) if q.startswith("GRANT"))
    create_db = next(i for i, q in enumerate(executed) if q.startswith("CREATE DATABASE"))
    create_role = next(i for i, q in enumerate(executed) if q.startswith("CREATE ROLE"))
    assert create_role < grant < create_db, executed
    assert executed[grant] == 'GRANT "erpclaw_t" TO CURRENT_USER'
