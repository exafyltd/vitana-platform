import os
import threading
import time

import pytest

from app.idempotency import IdempotencyConflict, MemoryReceiptStore, PostgresReceiptStore, request_hash


def _fn_factory(counter):
    def fn():
        counter.append(1)
        time.sleep(0.05)
        return "executed", {"n": len(counter)}
    return fn


def _exercise(store):
    calls = []
    h = request_hash("add-lead", {"lead_name": "x"}, False)
    r1, rep1 = store.execute_once("t", "key-0000001", "add-lead", h, _fn_factory(calls), 30)
    r2, rep2 = store.execute_once("t", "key-0000001", "add-lead", h, _fn_factory(calls), 30)
    assert (rep1, rep2) == (False, True) and len(calls) == 1 and r2.response == r1.response
    with pytest.raises(IdempotencyConflict):
        store.execute_once("t", "key-0000001", "add-lead", request_hash("add-lead", {"lead_name": "y"}, False), _fn_factory(calls), 30)
    # concurrent duplicates: exactly one execution, both get the same receipt
    calls2, results = [], []
    h2 = request_hash("add-lead", {"lead_name": "z"}, False)

    def worker():
        results.append(store.execute_once("t", "key-0000002", "add-lead", h2, _fn_factory(calls2), 30))
    ths = [threading.Thread(target=worker) for _ in range(6)]
    [t.start() for t in ths]; [t.join() for t in ths]
    assert len(calls2) == 1 and len(results) == 6
    assert {r.response["n"] for r, _ in results} == {1} and sorted(rep for _, rep in results) == [False] + [True] * 5
    assert store.get("t", "key-0000002").status == "executed"
    assert store.get("other-tenant", "key-0000002") is None


def test_memory_store():
    _exercise(MemoryReceiptStore())


def test_abandoned_in_progress_is_retried():
    store = MemoryReceiptStore()
    h = request_hash("a", {}, False)

    def boom():
        raise RuntimeError("process died")
    with pytest.raises(RuntimeError):
        store.execute_once("t", "key-0000003", "a", h, boom, 30)
    with pytest.raises(IdempotencyConflict):  # still in progress, not stale yet
        store.execute_once("t", "key-0000003", "a", h, lambda: ("executed", {}), 30)
    rec, rep = store.execute_once("t", "key-0000003", "a", h, lambda: ("executed", {"ok": 1}), stale_after_s=0)
    assert rec.status == "executed" and not rep


@pytest.mark.skipif(not os.environ.get("ERP_BRIDGE_TEST_DB_URL"), reason="ERP_BRIDGE_TEST_DB_URL not set")
def test_postgres_store_end_to_end():
    import psycopg2
    url = os.environ["ERP_BRIDGE_TEST_DB_URL"]
    c = psycopg2.connect(url); c.autocommit = True
    c.cursor().execute("DROP TABLE IF EXISTS vitana_bridge_receipt"); c.close()
    _exercise(PostgresReceiptStore(url, lock_timeout_s=20))
