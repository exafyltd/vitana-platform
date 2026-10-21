#!/usr/bin/env python3
"""Fake `aws` CLI for scripts/aws/test/aurora-apply-migration.sh (VTID-05023
part 8). Implements just what aurora-apply-migration.sh calls — sts
get-caller-identity, rds describe-db-clusters, rds-data begin/execute/commit/
rollback-transaction — against a LOCAL throwaway Postgres (PG* env).

A transaction is the list of statements executed in it so far. Each
execute-statement replays that list plus the new statement in one psql
transaction ending in ROLLBACK, so a failing statement fails at its own call
(as on Aurora) and nothing is persisted; commit-transaction replays the list
once more with `psql -1` for real; rollback-transaction forgets it. A failed
statement aborts the transaction, like Postgres.

Every invocation is appended to $FAKE_AWS_STATE/calls.jsonl.
Env: FAKE_AWS_STATE (required), FAKE_AWS_ACCOUNT (default 472838866351),
FAKE_AWS_NOT_ENABLED=<n> (first n rds-data calls answer HttpEndpointNotEnabled).
"""
import json
import os
import subprocess
import sys
import uuid

ACCOUNT = "472838866351"
REGION = "eu-central-1"
CLUSTER_ARN = f"arn:aws:rds:{REGION}:{ACCOUNT}:cluster:vitana-aurora-prod"
SECRET_ARN = f"arn:aws:secretsmanager:{REGION}:{ACCOUNT}:secret:rds!cluster-fake-AbCdEf"

STATE = os.environ["FAKE_AWS_STATE"]
for h in ("PGHOST",):
    if any(x in os.environ.get(h, "") for x in ("supabase", "amazonaws", "rds")):
        sys.exit("fake aws: refusing a non-throwaway PGHOST")


def log(entry):
    with open(os.path.join(STATE, "calls.jsonl"), "a") as fh:
        fh.write(json.dumps(entry) + "\n")


def fail(op, code, msg, rc=254):
    print(f"\nAn error occurred ({code}) when calling the {op} operation: {msg}", file=sys.stderr)
    sys.exit(rc)


def parse(argv):
    opts, i = {}, 0
    while i < len(argv):
        a = argv[i]
        if a.startswith("--"):
            if i + 1 < len(argv) and not argv[i + 1].startswith("--"):
                opts[a[2:]] = argv[i + 1]
                i += 2
            else:
                opts[a[2:]] = True
                i += 1
        else:
            i += 1
    if "cli-input-json" in opts:
        src = opts.pop("cli-input-json")
        assert src.startswith("file://"), src
        with open(src[7:], encoding="utf-8") as fh:
            body = json.load(fh)
        keymap = {"resourceArn": "resource-arn", "secretArn": "secret-arn", "database": "database",
                  "sql": "sql", "transactionId": "transaction-id"}
        for k, v in body.items():
            opts[keymap[k]] = v
    return opts


def psql(script, single_tx=False):
    args = ["psql", "-X", "-q", "-v", "ON_ERROR_STOP=1"] + (["-1"] if single_tx else [])
    return subprocess.run(args, input=script, capture_output=True, text=True)


def script_of(stmts):
    return "".join(s + "\n;\n" for s in stmts)


def tx_path(tx):
    return os.path.join(STATE, f"tx-{tx}.json")


def load_tx(op, tx):
    p = tx_path(tx)
    if not os.path.exists(p):
        fail(op, "BadRequestException", f"Transaction {tx} is not found")
    with open(p) as fh:
        return json.load(fh)


def save_tx(tx, data):
    with open(tx_path(tx), "w") as fh:
        json.dump(data, fh)


def main():
    argv = sys.argv[1:]
    service, op = (argv + ["", ""])[:2]
    opts = parse(argv[2:])
    log({"service": service, "op": op, "tx": opts.get("transaction-id"), "sql": opts.get("sql")})

    if service == "sts" and op == "get-caller-identity":
        print(os.environ.get("FAKE_AWS_ACCOUNT", ACCOUNT))
        return
    if service == "rds" and op == "describe-db-clusters":
        assert opts.get("region") == REGION and opts.get("db-cluster-identifier") == "vitana-aurora-prod", opts
        q = opts.get("query")
        print({"DBClusters[0].DBClusterArn": CLUSTER_ARN,
               "DBClusters[0].MasterUserSecret.SecretArn": SECRET_ARN}[q])
        return
    if service != "rds-data":
        sys.exit(f"fake aws: unsupported {service} {op}")

    if opts.get("region") != REGION or opts.get("resource-arn") != CLUSTER_ARN \
            or opts.get("secret-arn") != SECRET_ARN:
        fail(op, "BadRequestException", f"wrong region/cluster/secret: {opts}")
    counter = os.path.join(STATE, "not-enabled-count")
    left = int(os.environ.get("FAKE_AWS_NOT_ENABLED", "0"))
    used = int(open(counter).read()) if os.path.exists(counter) else 0
    if used < left:
        open(counter, "w").write(str(used + 1))
        fail(op, "BadRequestException", "HttpEndpointNotEnabled: HTTP endpoint isn't enabled for cluster")

    if op == "begin-transaction":
        assert opts.get("database") == "vitana", opts
        tx = uuid.uuid4().hex
        save_tx(tx, {"stmts": [], "aborted": False})
        print(json.dumps({"transactionId": tx}))
    elif op == "execute-statement":
        assert opts.get("database") == "vitana", opts
        sql, tx = opts["sql"], opts.get("transaction-id")
        if tx:
            st = load_tx("ExecuteStatement", tx)
            if st["aborted"]:
                fail("ExecuteStatement", "DatabaseErrorException",
                     "ERROR: current transaction is aborted, commands ignored until end of transaction block")
            r = psql("BEGIN;\n" + script_of(st["stmts"] + [sql]) + "ROLLBACK;\n")
            if r.returncode != 0:
                st["aborted"] = True
                save_tx(tx, st)
                fail("ExecuteStatement", "DatabaseErrorException", r.stderr.strip())
            st["stmts"].append(sql)
            save_tx(tx, st)
        else:
            r = psql(script_of([sql]))
            if r.returncode != 0:
                fail("ExecuteStatement", "DatabaseErrorException", r.stderr.strip())
        print(json.dumps({"numberOfRecordsUpdated": 0, "generatedFields": []}))
    elif op == "commit-transaction":
        tx = opts["transaction-id"]
        st = load_tx("CommitTransaction", tx)
        os.remove(tx_path(tx))
        if st["aborted"]:
            fail("CommitTransaction", "BadRequestException", "transaction aborted")
        r = psql(script_of(st["stmts"]), single_tx=True)
        if r.returncode != 0:
            fail("CommitTransaction", "DatabaseErrorException", r.stderr.strip())
        print(json.dumps({"transactionStatus": "Transaction Committed"}))
    elif op == "rollback-transaction":
        tx = opts["transaction-id"]
        load_tx("RollbackTransaction", tx)
        os.remove(tx_path(tx))
        print(json.dumps({"transactionStatus": "Rollback Complete"}))
    else:
        sys.exit(f"fake aws: unsupported rds-data {op}")


if __name__ == "__main__":
    main()
