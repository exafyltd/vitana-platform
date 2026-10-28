import sys

import pytest

from app import runner as R
from app.catalog import CATALOG


def test_argv_is_built_only_from_the_spec(settings):
    t = settings.tenants["tenant-a"]
    argv = R.build_argv(settings, CATALOG["add-journal-entry"], t,
                        {"posting_date": "2026-09-13", "entry_type": "journal",
                         "lines": [{"account_id": "x", "debit": "1", "credit": "0"}]}, confirmed=False)
    assert argv[:2] == [sys.executable, settings.router_path]
    assert argv[2:6] == ["--action", "add-journal-entry", "--company-id", "co-a"]
    assert "--lines" in argv and '[{"account_id":"x","credit":"0","debit":"1"}]' in argv
    assert "--user-confirmed" not in argv


def test_user_confirmed_only_for_gated_actions_and_only_when_confirmed(settings):
    t = settings.tenants["tenant-a"]
    a = R.build_argv(settings, CATALOG["submit-journal-entry"], t, {"journal_entry_id": "j1"}, confirmed=True)
    assert a[-1] == "--user-confirmed"
    b = R.build_argv(settings, CATALOG["submit-journal-entry"], t, {"journal_entry_id": "j1"}, confirmed=False)
    assert "--user-confirmed" not in b
    c = R.build_argv(settings, CATALOG["add-lead"], t, {"lead_name": "x"}, confirmed=True)  # not ERPClaw-gated
    assert "--user-confirmed" not in c


@pytest.mark.parametrize("params", [
    {"db_path": "/tmp/x"}, {"company_id": "other"}, {"user_confirmed": True}, {"force": True},
    {"posting_date": "--force"}, {"remark": "-x"}, {"nope_not_a_flag": "1"}, {"lines": True},
    {"posting_date": "a\x00b"},
])
def test_smuggled_flags_and_values_are_refused(settings, params):
    t = settings.tenants["tenant-a"]
    with pytest.raises(R.RunnerError):
        R.build_argv(settings, CATALOG["add-journal-entry"], t, params, confirmed=False)


def test_company_scoped_action_needs_a_configured_company(settings):
    t = settings.tenants["tenant-nocompany"]
    with pytest.raises(R.RunnerError):
        R.build_argv(settings, CATALOG["list-accounts"], t, {}, confirmed=False)
    # list-companies is not company-scoped and still works for that tenant
    assert "--company-id" not in R.build_argv(settings, CATALOG["list-companies"], t, {}, confirmed=False)


def test_store_true_flags_take_booleans_only(settings):
    t = settings.tenants["tenant-a"]
    a = R.build_argv(settings, CATALOG["add-tax-template"], t, {"name": "x", "tax_type": "sales", "lines": [], "is_default": True}, confirmed=True)
    assert "--is-default" in a and a[a.index("--is-default") + 1] != "True"
    with pytest.raises(R.RunnerError):
        R.build_argv(settings, CATALOG["add-tax-template"], t, {"is_default": "yes"}, confirmed=True)


def test_subprocess_env_is_minimal_and_redaction_hides_the_url(settings):
    t = settings.tenants["tenant-a"]
    env = R._env_for(settings, t)
    assert set(env) == {"PATH", "HOME", "LANG", "PYTHONDONTWRITEBYTECODE", "PYTHONIOENCODING",
                        "ERPCLAW_HOME", "ERPCLAW_DB_DIALECT", "ERPCLAW_DB_URL"}
    redact = R._redactor(t)
    assert "pw-secret" not in redact("failed: postgresql://u:pw-secret@db.internal:5432/erp_a boom")
    assert "db.internal" not in redact("host db.internal:5432 unreachable")


def test_real_subprocess_runs_with_timeout_and_json(settings, tmp_path):
    # Replace the fake router with a tiny script that echoes argv as JSON.
    router = tmp_path / "erpclaw" / "scripts" / "db_query.py"
    router.write_text("import json,sys,os\nprint(json.dumps({'status':'ok','argv':sys.argv[1:],'env_url':os.environ.get('ERPCLAW_DB_URL')}))\n")
    t = settings.tenants["tenant-a"]
    res = R.run(settings, CATALOG["list-companies"], t, {"limit": 5}, confirmed=False)
    assert res.rc == 0 and res.result["argv"] == ["--action", "list-companies", "--limit", "5"]
    assert res.result["env_url"] == "<redacted>"     # leaked URL redacted even inside JSON
    router.write_text("import time\ntime.sleep(30)\n")
    slow = R.run(settings, CATALOG["list-companies"], t, {}, confirmed=False)
    assert slow.timed_out and slow.rc == -1
