#!/usr/bin/env python3
"""Backfill pgvector embeddings from Supabase into Aurora (VTID-04755).

DMS truncates pgvector values on the Supabase read, so after the full load
every embedding on Aurora is NULL (2026-10-09 dress rehearsal: 0 of 7,942
arrived complete). This copies them directly:

  Supabase  -- read-only transactions, keyset pages of 200 rows
  Aurora    -- RDS Data API, 25 rows per transaction, with
               session_replication_role = replica so no trigger fires
               (an updated_at trigger would otherwise restamp every row)

Then it compares non-NULL counts per column, puts NOT NULL back on the two
columns that have it on Supabase (only if no NULL is left), and rebuilds
the IVFFlat indexes, which were built on empty columns by the post-load.

Re-runnable: it only ever sets an embedding to Supabase's current value.
Run AFTER aurora-cutover-after-load.sh:  python3 aurora-cutover-embedding-backfill.py
Needs: secretsmanager:GetSecretValue on vitana/supabase/prod/database-url and
the cluster's master secret, rds-data:*. Prints no credentials.
"""
import json
import subprocess
import sys
import time
import urllib.parse

import boto3

try:
    import psycopg2
except ImportError:
    subprocess.check_call([sys.executable, "-m", "pip", "install", "--user", "-q", "psycopg2-binary"])
    import site
    sys.path.append(site.getusersitepackages())
    import psycopg2

REGION = "eu-central-1"
CLUSTER = "vitana-aurora-prod"
CLUSTER_ARN = f"arn:aws:rds:{REGION}:472838866351:cluster:{CLUSTER}"
DB = "vitana"
PAGE = 200
BATCH = 25

# (table, column, primary key, primary key type) -- same on both sides (checked 2026-10-09)
COLUMNS = [
    ("ai_memory", "embedding", "id", "uuid"),
    ("calendar_events", "embedding", "id", "uuid"),
    ("dev_agent_memory", "embedding", "id", "uuid"),
    ("feedback_tickets", "embedding", "id", "uuid"),
    ("mem_episodes", "embedding", "id", "uuid"),
    ("mem_facts", "embedding", "id", "uuid"),
    ("memory_embeddings", "embedding", "embedding_id", "uuid"),
    ("memory_facts", "embedding", "id", "uuid"),
    ("memory_items", "embedding", "id", "uuid"),
    ("user_intents", "embedding", "intent_id", "uuid"),
    ("user_intents", "embedding_v2", "intent_id", "uuid"),
    ("vtid_ledger", "embedding", "id", "text"),
    ("vtid_ledger", "embedding_v2", "id", "text"),
]
# NOT NULL on Supabase; dropped by the post-load so truncated values could be NULLed.
RESTORE_NOT_NULL = [("dev_agent_memory", "embedding"), ("memory_embeddings", "embedding")]
# IVFFlat picks its centroids at build time; the post-load built these on empty columns.
REINDEX = ["ai_memory_embedding_idx", "dev_agent_memory_embedding_idx", "idx_mem_emb_vector"]


def supabase_dsn(secrets):
    raw = secrets.get_secret_value(SecretId="vitana/supabase/prod/database-url")["SecretString"].strip()
    if raw.startswith("{"):
        obj = json.loads(raw)
        raw = next(v for k, v in obj.items() if isinstance(v, str) and v.startswith("postgres"))
    u = urllib.parse.urlsplit(raw)
    # keep only sslmode; pooler-specific params (pgbouncer=true, ...) break libpq
    q = {k: v for k, v in urllib.parse.parse_qsl(u.query) if k == "sslmode"}
    q.setdefault("sslmode", "require")
    return urllib.parse.urlunsplit((u.scheme, u.netloc, u.path, urllib.parse.urlencode(q), ""))


class Aurora:
    def __init__(self, data, secret_arn):
        self.data, self.secret = data, secret_arn

    def _call(self, fn, **kw):
        kw.update(resourceArn=CLUSTER_ARN, secretArn=self.secret)
        for attempt in range(8):
            try:
                return fn(**kw)
            except self.data.exceptions.StatementTimeoutException:
                raise
            except Exception as e:  # throttling / transient
                name = type(e).__name__
                if attempt < 7 and any(s in str(e) for s in ("Throttl", "TooManyRequests", "ServiceUnavailable", "Communications link")):
                    time.sleep(2 ** attempt)
                    continue
                raise RuntimeError(f"{name}: {e}") from None

    def query(self, sql):
        r = self._call(self.data.execute_statement, database=DB, sql=sql)
        return [[next(iter(f.values())) if f.get("isNull") is None else None for f in rec] for rec in r.get("records", [])]

    def run(self, sql):
        self._call(self.data.execute_statement, database=DB, sql=sql)

    def probe_replica_role(self):
        tx = self._call(self.data.begin_transaction, database=DB)["transactionId"]
        try:
            self._call(self.data.execute_statement, database=DB, transactionId=tx,
                       sql="SET LOCAL session_replication_role = replica")
        finally:
            self._call(self.data.rollback_transaction, transactionId=tx)

    def update_batch(self, sql, param_sets):
        tx = self._call(self.data.begin_transaction, database=DB)["transactionId"]
        try:
            self._call(self.data.execute_statement, database=DB, transactionId=tx,
                       sql="SET LOCAL session_replication_role = replica")
            self._call(self.data.batch_execute_statement, database=DB, transactionId=tx,
                       sql=sql, parameterSets=param_sets)
            self._call(self.data.commit_transaction, transactionId=tx)
        except Exception:
            try:
                self._call(self.data.rollback_transaction, transactionId=tx)
            finally:
                raise


def copy_column(src, aurora, table, col, pk, pktype):
    sql = f"UPDATE public.{table} SET {col} = CAST(:v AS vector) WHERE {pk} = CAST(:k AS {pktype})"
    last, sent = "", 0
    while True:
        with src.cursor() as cur:
            cur.execute(
                f'SELECT {pk}::text, {col}::text FROM public."{table}" '
                f"WHERE {col} IS NOT NULL AND {pk}::text > %s ORDER BY {pk}::text LIMIT %s",
                (last, PAGE),
            )
            rows = cur.fetchall()
        src.commit()
        if not rows:
            return sent
        for i in range(0, len(rows), BATCH):
            chunk = rows[i:i + BATCH]
            aurora.update_batch(sql, [
                [{"name": "k", "value": {"stringValue": k}}, {"name": "v", "value": {"stringValue": v}}]
                for k, v in chunk
            ])
            sent += len(chunk)
        last = rows[-1][0]
        print(f"  {table}.{col}: {sent} sent", end="\r", flush=True)


def main():
    secrets = boto3.client("secretsmanager", REGION)
    rds = boto3.client("rds", REGION)
    secret_arn = rds.describe_db_clusters(DBClusterIdentifier=CLUSTER)["DBClusters"][0]["MasterUserSecret"]["SecretArn"]
    aurora = Aurora(boto3.client("rds-data", REGION), secret_arn)

    src = psycopg2.connect(supabase_dsn(secrets), connect_timeout=15)
    src.set_session(readonly=True, autocommit=False)

    # Fail before writing anything if triggers can't be switched off.
    aurora.probe_replica_role()

    print("== 1/3 copy embeddings (Supabase -> Aurora)")
    for table, col, pk, pktype in COLUMNS:
        t0 = time.time()
        n = copy_column(src, aurora, table, col, pk, pktype)
        print(f"  {table}.{col}: {n} sent in {time.time() - t0:.0f}s      ")

    print("== 2/3 verify: column, Supabase non-null, Aurora non-null")
    bad = 0
    for table, col, _, _ in COLUMNS:
        with src.cursor() as cur:
            cur.execute(f'SELECT count({col}) FROM public."{table}"')
            s = cur.fetchone()[0]
        src.commit()
        a = aurora.query(f"SELECT count({col}) FROM public.{table}")[0][0]
        flag = "" if a == s else "   <-- MISMATCH (rows added/removed on Supabase since the load?)"
        bad += a != s
        print(f"  {table}.{col}: {s} {a}{flag}")

    print("== 3/3 restore NOT NULL, rebuild IVFFlat indexes")
    for table, col in RESTORE_NOT_NULL:
        nulls = aurora.query(f"SELECT count(*) FROM public.{table} WHERE {col} IS NULL")[0][0]
        if nulls:
            print(f"  NOT restoring NOT NULL on {table}.{col}: {nulls} NULL rows left")
            bad += 1
        else:
            aurora.run(f"ALTER TABLE public.{table} ALTER COLUMN {col} SET NOT NULL")
            print(f"  {table}.{col}: NOT NULL restored")
    for idx in REINDEX:
        aurora.run(f"REINDEX INDEX public.{idx}")
        print(f"  {idx}: rebuilt")

    src.close()
    print("ALL DONE" if not bad else f"DONE WITH {bad} WARNING(S) -- send this output to Claude")


if __name__ == "__main__":
    main()
