"""Idempotency + receipts for erp-bridge (VTID-03840).

The spike (docs/validation/VTID-03840/outputs/07-idempotent-retry-naive.txt)
showed ERPClaw has no idempotency key: a retried `add-*` command creates a
second document. So the bridge owns it:

    (tenant, idempotency_key) -> receipt

- First call: insert an `in_progress` receipt, run the action, store the
  outcome. The whole thing runs under a per-key advisory lock, so a
  duplicate that arrives mid-flight WAITS and then replays the stored
  receipt instead of executing again.
- Replay: same key + same request hash -> the stored receipt, `replayed: true`.
- Conflict: same key, different request hash -> 409; nothing runs.
- A receipt left `in_progress` past the subprocess timeout (process died)
  is treated as abandoned and the retry is allowed to execute.

Receipts live in the TENANT's own ERPClaw database (table
`vitana_bridge_receipt`), so tenant isolation and backup/restore come for
free with the ledger they describe. A memory store backs unit tests.
"""
from __future__ import annotations

import hashlib
import json
import threading
import time
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Any, Callable, Iterator


class IdempotencyConflict(Exception):
    def __init__(self, reason: str):
        super().__init__(reason)
        self.reason = reason


@dataclass
class Receipt:
    idempotency_key: str
    tenant_id: str
    action: str
    request_hash: str
    status: str                   # in_progress | executed | failed
    response: dict[str, Any] | None
    created_at: float
    completed_at: float | None = None


def request_hash(action: str, params: dict[str, Any], confirmed: bool) -> str:
    canon = json.dumps({"a": action, "p": params, "c": bool(confirmed)},
                       sort_keys=True, separators=(",", ":"), ensure_ascii=True)
    return hashlib.sha256(canon.encode("utf-8")).hexdigest()


class ReceiptStore:
    """Interface. `execute_once` is the only entry point callers use."""

    def execute_once(self, tenant_id: str, key: str, action: str, rhash: str,
                     fn: Callable[[], tuple[str, dict[str, Any]]],
                     stale_after_s: float) -> tuple[Receipt, bool]:
        raise NotImplementedError

    def get(self, tenant_id: str, key: str) -> Receipt | None:
        raise NotImplementedError


def _decide(existing: Receipt | None, rhash: str, stale_after_s: float, now: float) -> str:
    """Return 'run' | 'replay' | raise IdempotencyConflict."""
    if existing is None:
        return "run"
    if existing.request_hash != rhash:
        raise IdempotencyConflict("idempotency_key reused with a different request")
    if existing.status == "in_progress":
        if now - existing.created_at > stale_after_s:
            return "run"          # abandoned by a dead process
        raise IdempotencyConflict("request with this idempotency_key is still in progress")
    return "replay"


class MemoryReceiptStore(ReceiptStore):
    def __init__(self) -> None:
        self._rows: dict[tuple[str, str], Receipt] = {}
        self._locks: dict[tuple[str, str], threading.Lock] = {}
        self._guard = threading.Lock()

    def _lock_for(self, k: tuple[str, str]) -> threading.Lock:
        with self._guard:
            return self._locks.setdefault(k, threading.Lock())

    def get(self, tenant_id: str, key: str) -> Receipt | None:
        return self._rows.get((tenant_id, key))

    def execute_once(self, tenant_id, key, action, rhash, fn, stale_after_s):
        k = (tenant_id, key)
        with self._lock_for(k):
            now = time.time()
            decision = _decide(self._rows.get(k), rhash, stale_after_s, now)
            if decision == "replay":
                return self._rows[k], True
            rec = Receipt(key, tenant_id, action, rhash, "in_progress", None, now)
            self._rows[k] = rec
            status, response = fn()
            rec.status, rec.response, rec.completed_at = status, response, time.time()
            return rec, False


_DDL = """
CREATE TABLE IF NOT EXISTS vitana_bridge_receipt (
    idempotency_key text PRIMARY KEY,
    tenant_id       text NOT NULL,
    action          text NOT NULL,
    request_hash    text NOT NULL,
    status          text NOT NULL,
    response        jsonb,
    created_at      timestamptz NOT NULL DEFAULT now(),
    completed_at    timestamptz
);
CREATE INDEX IF NOT EXISTS idx_vitana_bridge_receipt_created ON vitana_bridge_receipt (created_at);
"""


class PostgresReceiptStore(ReceiptStore):
    """One store per tenant DB URL. Uses psycopg2 lazily (import at call time
    so unit tests without the driver still import this module)."""

    def __init__(self, db_url: str, lock_timeout_s: float = 90.0) -> None:
        self._url = db_url
        self._lock_timeout_ms = int(lock_timeout_s * 1000)
        self._ddl_done = False

    @contextmanager
    def _conn(self) -> Iterator[Any]:
        import psycopg2
        conn = psycopg2.connect(self._url)
        try:
            yield conn
        finally:
            conn.close()

    def _ensure_table(self, conn) -> None:
        if self._ddl_done:
            return
        with conn.cursor() as cur:
            cur.execute("SELECT pg_advisory_xact_lock(hashtext('vitana_bridge_receipt_ddl'))")
            cur.execute(_DDL)
        conn.commit()
        self._ddl_done = True

    @staticmethod
    def _row_to_receipt(row) -> Receipt | None:
        if not row:
            return None
        key, tenant, action, rhash, status, response, created, completed = row
        return Receipt(key, tenant, action, rhash, status, response,
                       created.timestamp(), completed.timestamp() if completed else None)

    _SELECT = ("SELECT idempotency_key, tenant_id, action, request_hash, status, response, "
               "created_at, completed_at FROM vitana_bridge_receipt WHERE idempotency_key = %s")

    def get(self, tenant_id: str, key: str) -> Receipt | None:
        with self._conn() as conn:
            self._ensure_table(conn)
            with conn.cursor() as cur:
                cur.execute(self._SELECT, (key,))
                rec = self._row_to_receipt(cur.fetchone())
        return rec if rec and rec.tenant_id == tenant_id else None

    def execute_once(self, tenant_id, key, action, rhash, fn, stale_after_s):
        with self._conn() as conn:
            self._ensure_table(conn)
            with conn.cursor() as cur:
                cur.execute("SET lock_timeout = %s", (self._lock_timeout_ms,))
                # Per-key serialization for the whole run: a duplicate blocks
                # here until the first execution commits, then replays.
                cur.execute("SELECT pg_advisory_xact_lock(hashtext(%s))", (f"receipt:{key}",))
                cur.execute(self._SELECT + " FOR UPDATE", (key,))
                existing = self._row_to_receipt(cur.fetchone())
                if existing and existing.tenant_id != tenant_id:
                    raise IdempotencyConflict("idempotency_key belongs to another tenant")
                decision = _decide(existing, rhash, stale_after_s, time.time())
                if decision == "replay":
                    conn.rollback()
                    return existing, True
                if existing is None:
                    cur.execute(
                        "INSERT INTO vitana_bridge_receipt (idempotency_key, tenant_id, action, "
                        "request_hash, status) VALUES (%s, %s, %s, %s, 'in_progress')",
                        (key, tenant_id, action, rhash))
                else:  # abandoned in_progress -> re-run
                    cur.execute("UPDATE vitana_bridge_receipt SET created_at = now(), completed_at = NULL, "
                                "response = NULL, status = 'in_progress' WHERE idempotency_key = %s", (key,))
                status, response = fn()
                cur.execute(
                    "UPDATE vitana_bridge_receipt SET status = %s, response = %s::jsonb, completed_at = now() "
                    "WHERE idempotency_key = %s",
                    (status, json.dumps(response), key))
                cur.execute(self._SELECT, (key,))
                rec = self._row_to_receipt(cur.fetchone())
            conn.commit()
            return rec, False
