from app.runner import RunResult


def _req(**kw):
    base = {"tenant_id": "tenant-a", "action": "list-accounts", "idempotency_key": "idem-00000001",
            "params": {}, "actor": {"user_id": "u1", "channel": "web"}}
    base.update(kw)
    return base


def test_alive_and_ready_need_no_token(client):
    client.headers.pop("X-ERP-Bridge-Token")
    assert client.get("/alive").json()["service"] == "erp-bridge"
    assert client.get("/ready").json()["ok"] is True


def test_v1_refuses_without_token(client):
    client.headers.pop("X-ERP-Bridge-Token")
    assert client.get("/v1/catalog").status_code == 401
    assert client.post("/v1/execute", json=_req()).status_code == 401


def test_catalog_lists_actions_without_secrets(client):
    body = client.get("/v1/catalog").json()
    assert body["ok"] and any(a["action"] == "add-lead" for a in body["actions"])
    assert "postgresql://" not in client.get("/v1/catalog").text


def test_read_action_executes_and_replays(client, fake_runner):
    r = client.post("/v1/execute", json=_req(params={"limit": 3}))
    assert r.status_code == 200, r.text
    rec = r.json()["receipt"]
    assert rec["status"] == "executed" and rec["replayed"] is False and rec["tier"] == "read"
    r2 = client.post("/v1/execute", json=_req(params={"limit": 3}))
    assert r2.json()["receipt"]["replayed"] is True and len(fake_runner.calls) == 1
    r3 = client.post("/v1/execute", json=_req(params={"limit": 4}))
    assert r3.status_code == 409
    g = client.get("/v1/receipts/tenant-a/idem-00000001")
    assert g.status_code == 200 and g.json()["receipt"]["status"] == "executed"


def test_unknown_or_never_exposed_action_is_refused_before_running(client, fake_runner):
    for a in ("post-gl-entries", "install-module", "migrate", "not-a-thing"):
        assert client.post("/v1/execute", json=_req(action=a)).status_code == 403
    assert fake_runner.calls == []


def test_unknown_tenant_is_404(client):
    assert client.post("/v1/execute", json=_req(tenant_id="ghost")).status_code == 404


def test_commit_tier_requires_confirmation_and_sets_user_confirmed(client, fake_runner):
    body = _req(action="submit-journal-entry", params={"journal_entry_id": "j1"}, idempotency_key="idem-00000002")
    r = client.post("/v1/execute", json=body)
    assert r.status_code == 403 and r.json()["detail"]["error"] == "confirmation_required"
    body["confirmation"] = {"granted": True}
    r = client.post("/v1/execute", json=body)
    assert r.status_code == 200 and fake_runner.calls[-1] == ("submit-journal-entry", "tenant-a", {"journal_entry_id": "j1"}, True)


def test_high_risk_needs_maker_checker_and_never_voice(client, fake_runner):
    body = _req(action="cancel-journal-entry", params={"journal_entry_id": "j1"}, idempotency_key="idem-00000003",
                confirmation={"granted": True})
    assert client.post("/v1/execute", json=body).json()["detail"]["error"] == "approval_required"
    body["confirmation"] = {"granted": True, "approval_id": "ap1", "approved_by": "u1", "requested_by": "u1"}
    assert client.post("/v1/execute", json=body).json()["detail"]["error"] == "maker_checker_violation"
    body["confirmation"]["approved_by"] = "u2"
    body["actor"] = {"user_id": "u1", "channel": "voice"}
    assert client.post("/v1/execute", json=body).json()["detail"]["error"] == "voice_cannot_confirm_high_risk"
    body["actor"] = {"user_id": "u1", "channel": "web"}
    r = client.post("/v1/execute", json=body)
    assert r.status_code == 200 and fake_runner.calls[-1][3] is True


def test_smuggled_flag_is_422_and_burns_no_key(client, fake_runner):
    r = client.post("/v1/execute", json=_req(params={"db_path": "/etc/passwd"}, idempotency_key="idem-00000004"))
    assert r.status_code == 422 and fake_runner.calls == []
    r = client.post("/v1/execute", json=_req(params={}, idempotency_key="idem-00000004"))
    assert r.status_code == 200 and r.json()["receipt"]["replayed"] is False


def test_erpclaw_error_becomes_failed_receipt(client, fake_runner):
    fake_runner.next = RunResult(rc=1, duration_ms=2, timed_out=False, result={"status": "error", "message": "nope"},
                                 stdout_tail="", stderr_tail="", argv_public=[])
    r = client.post("/v1/execute", json=_req(idempotency_key="idem-00000005"))
    assert r.status_code == 200 and r.json()["ok"] is False and r.json()["receipt"]["status"] == "failed"
