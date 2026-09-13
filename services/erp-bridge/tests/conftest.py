import os
import sys

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from app.config import Settings, Tenant  # noqa: E402
from app.idempotency import MemoryReceiptStore  # noqa: E402
from app.main import create_app  # noqa: E402
from app.runner import RunResult  # noqa: E402

TOKEN = "t" * 40


@pytest.fixture
def settings(tmp_path):
    root = tmp_path / "erpclaw"
    (root / "scripts").mkdir(parents=True)
    (root / "scripts" / "db_query.py").write_text("# fake router\n")
    return Settings(
        token=TOKEN, erpclaw_root=str(root), erpclaw_home=str(tmp_path / "home"),
        tenants={
            "tenant-a": Tenant("tenant-a", "postgresql://u:pw-secret@db.internal:5432/erp_a", "co-a"),
            "tenant-nocompany": Tenant("tenant-nocompany", "postgresql://u:pw@db.internal:5432/erp_b", None),
        },
        subprocess_timeout_s=5.0, env="test",
    )


class FakeRunner:
    def __init__(self):
        self.calls = []
        self.next = None

    def __call__(self, settings, spec, tenant, params, confirmed):
        self.calls.append((spec.name, tenant.tenant_id, dict(params), confirmed))
        if self.next:
            return self.next
        return RunResult(rc=0, duration_ms=3, timed_out=False, result={"status": "ok", "echo": params},
                         stdout_tail="", stderr_tail="", argv_public=["--action", spec.name])


@pytest.fixture
def fake_runner():
    return FakeRunner()


@pytest.fixture
def client(settings, fake_runner):
    from fastapi.testclient import TestClient
    app = create_app(settings=settings, store_factory=lambda t: MemoryReceiptStore(), run_fn=fake_runner)
    with TestClient(app) as c:
        c.headers.update({"X-ERP-Bridge-Token": TOKEN})
        yield c
