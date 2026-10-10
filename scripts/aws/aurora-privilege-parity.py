#!/usr/bin/env python3
"""Aurora privilege-parity gate (VTID-05023, part 0).

The PostgREST-Aurora proxy must never give anon / authenticated /
service_role more on Aurora than they have on Supabase (sparring finding F1:
GRANT ALL to anon from setup-aurora-postgrest-grants.sh, Supabase's anon RPC
lockdown incl. increment_wallet_balance missing on Aurora, tables without
RLS). This script compares two catalog snapshots produced by the SAME
read-only query, scripts/aws/aurora-privilege-parity-snapshot.sql:

  A  Supabase  --supabase-snapshot FILE   (taken separately, read-only SQL)
  B  Aurora    via the RDS Data API (default), or --aurora-snapshot FILE

Modes (at least one):
  --check   readable report on stdout, JSON report to --report; exit 1 on
            any EXTRA grant, RLS / role-setting / role-attribute mismatch,
            extra role membership or extra default privilege. MISSING only
            warns unless --strict.
  --fix     writes the SQL that makes Aurora match Supabase to --out, one
            statement per line, for scripts/aws/aurora-run-sql.sh. This
            script NEVER executes a write: the only statement it sends to
            Aurora is the read-only snapshot SELECT.

Exit codes: 0 parity (or warnings only), 1 gate failed, 2 bad input/usage.

Run order (runbook "Part 0"): against the Aurora clone first, before the
public data host serves anything, and again after every final load. After
running a --fix file, run --check again: a REVOKE issued by a role that is
not the grantor/owner is a silent no-op in PostgreSQL.

Dependencies: python3 stdlib; boto3 only for the live Aurora read.
"""
from __future__ import annotations

import argparse
import datetime as _dt
import hashlib
import json
import os
import re
import sys
from typing import Any, Dict, Iterable, List, Optional, Tuple

EXPECTED_ACCOUNT = "472838866351"
EXPECTED_REGION = "eu-central-1"
DEFAULT_CLUSTER = "vitana-aurora-prod"
DEFAULT_DATABASE = "vitana"
API_ROLES = ("anon", "authenticated", "service_role")
SNAPSHOT_SQL_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                 "aurora-privilege-parity-snapshot.sql")
REQUIRED_KEYS = ("table_grants", "routine_grants", "rls", "default_acl", "role_settings")
OPTIONAL_LIST_KEYS = ("column_grants", "role_attributes", "role_memberships", "roles")

TABLE_PRIVILEGES = {"SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES",
                    "TRIGGER", "MAINTAIN", "USAGE"}
ROUTINE_PRIVILEGES = {"EXECUTE"}
# Privileges that exist only on some server versions (MAINTAIN: PG17+). A
# difference in these is reported, never gated and never "fixed", because the
# statement would fail on the older server.
VERSION_SPECIFIC_PRIVILEGES = {"MAINTAIN"}

DEFACL_OBJTYPES = {"r": "TABLES", "S": "SEQUENCES", "f": "FUNCTIONS", "T": "TYPES", "n": "SCHEMAS"}
RELKIND_OBJECT = {"S": "SEQUENCE"}  # everything else uses ON TABLE

# Settings whose value is a duration; compared in milliseconds.
DURATION_SETTINGS = {"statement_timeout", "lock_timeout", "idle_in_transaction_session_timeout",
                     "idle_session_timeout", "transaction_timeout"}
_DURATION_UNITS = {"us": 0.001, "ms": 1, "s": 1000, "min": 60000, "h": 3600000, "d": 86400000}

# PostgreSQL reserved key words (SQL Key Words appendix, "reserved" and
# "reserved (can be function or type)"). Identifiers equal to one of these
# must be quoted.
RESERVED_WORDS = frozenset("""
all analyse analyze and any array as asc asymmetric authorization binary both case cast
check collate collation column concurrently constraint create cross current_catalog
current_date current_role current_schema current_time current_timestamp current_user
default deferrable desc distinct do else end except false fetch for foreign freeze from
full grant group having ilike in initially inner intersect into is isnull join lateral
leading left like limit localtime localtimestamp natural not notnull null offset on only
or order outer overlaps placing primary references returning right select session_user
similar some symmetric system_user table tablesample then to trailing true union unique
user using variadic verbose when where window with
""".split())

_SIMPLE_IDENT = re.compile(r"^[a-z_][a-z0-9_$]*$")
_SAFE_ARGS = re.compile(r'^[A-Za-z0-9_ ,."\[\]()$]*$')
_SAFE_SETTING_NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_.]*$")


class SnapshotError(ValueError):
    """A snapshot is missing, malformed or unsafe to turn into SQL."""


# ---------------------------------------------------------------- quoting

def quote_ident(name: str) -> str:
    """Quote a PostgreSQL identifier only when needed ("VtidLedger", "user")."""
    if not isinstance(name, str) or name == "":
        raise SnapshotError(f"invalid identifier: {name!r}")
    if "\x00" in name or "\n" in name or "\r" in name:
        raise SnapshotError(f"identifier contains a control character: {name!r}")
    if _SIMPLE_IDENT.match(name) and name not in RESERVED_WORDS:
        return name
    return '"' + name.replace('"', '""') + '"'


def quote_role(name: str) -> str:
    return "PUBLIC" if name == "PUBLIC" else quote_ident(name)


def quote_literal(value: str) -> str:
    if "\x00" in value or "\n" in value or "\r" in value:
        raise SnapshotError(f"setting value contains a control character: {value!r}")
    return "'" + value.replace("'", "''") + "'"


def qualified(schema: Optional[str], name: str) -> str:
    return f"{quote_ident(schema or 'public')}.{quote_ident(name)}"


def routine_ref(row: Dict[str, Any]) -> str:
    """public."GetVtid"(text) — name quoted, arg types as format_type printed them."""
    name, args = row.get("routine_name"), row.get("routine_args")
    if name is None or args is None:
        sig = row.get("routine_signature") or ""
        if not sig.endswith(")") or "(" not in sig:
            raise SnapshotError(f"routine signature without argument list: {sig!r}")
        name, args = sig[: sig.index("(")], sig[sig.index("(") + 1: -1]
    if not _SAFE_ARGS.match(args) or ";" in args or "--" in args:
        raise SnapshotError(f"unexpected characters in argument types of {name!r}: {args!r}")
    return f"{qualified(row.get('schema'), name)}({args})"


# ---------------------------------------------------------------- loading

def _concat_chunks(rows: List[Dict[str, Any]]) -> str:
    rows = sorted(rows, key=lambda r: int(r["i"]))
    if [int(r["i"]) for r in rows] != list(range(len(rows))):
        raise SnapshotError("chunked snapshot has gaps in its chunk index")
    text = "".join(r["chunk"] for r in rows)
    want = rows[0].get("md5")
    if want and hashlib.md5(text.encode("utf-8")).hexdigest() != want:
        raise SnapshotError("chunked snapshot md5 mismatch (catalog changed between chunks?)")
    return text


def normalize_snapshot(raw: Any, label: str) -> Dict[str, Any]:
    """Accept the bare document, [{"snapshot": "<json>"}], {"snapshot": ...}
    or chunk rows [{"i", "chunk", "md5"}] and return the validated document."""
    doc = raw
    if isinstance(doc, list) and doc and isinstance(doc[0], dict) and "chunk" in doc[0]:
        doc = _concat_chunks(doc)
    if isinstance(doc, list) and len(doc) == 1 and isinstance(doc[0], dict) and "snapshot" in doc[0]:
        doc = doc[0]["snapshot"]
    if isinstance(doc, dict) and "snapshot" in doc and "table_grants" not in doc:
        doc = doc["snapshot"]
    if isinstance(doc, str):
        try:
            doc = json.loads(doc)
        except json.JSONDecodeError as exc:
            raise SnapshotError(f"{label}: snapshot text is not JSON: {exc}") from exc
    if not isinstance(doc, dict):
        raise SnapshotError(f"{label}: snapshot must be a JSON object")
    missing = [k for k in REQUIRED_KEYS if not isinstance(doc.get(k), list)]
    if missing:
        raise SnapshotError(f"{label}: snapshot lacks list key(s): {', '.join(missing)}")
    for key in OPTIONAL_LIST_KEYS:
        if key in doc and doc[key] is not None and not isinstance(doc[key], list):
            raise SnapshotError(f"{label}: {key} must be a list")
    return doc


def load_snapshot(path: str, label: str) -> Dict[str, Any]:
    try:
        with open(path, "r", encoding="utf-8") as fh:
            raw = json.load(fh)
    except (OSError, json.JSONDecodeError) as exc:
        raise SnapshotError(f"{label}: cannot read {path}: {exc}") from exc
    return normalize_snapshot(raw, label)


def read_snapshot_sql(path: str = SNAPSHOT_SQL_PATH) -> str:
    with open(path, "r", encoding="utf-8") as fh:
        text = fh.read()
    lines = [ln for ln in text.splitlines() if not ln.lstrip().startswith("--")]
    body = "\n".join(lines).strip()
    if body.endswith(";"):
        body = body[:-1].rstrip()
    if not re.match(r"^WITH\b", body, re.IGNORECASE) and not re.match(r"^SELECT\b", body, re.IGNORECASE):
        raise SnapshotError("snapshot SQL must be a single SELECT/WITH statement")
    return body


def chunked_sql(snapshot_sql: str, first: int, last: int, size: int = 30000) -> str:
    """Wrap the snapshot SELECT so it returns chunk rows i in [first, last],
    each at most `size` characters, plus the whole document's md5 and length."""
    return (
        "SELECT i, md5(s.snapshot) AS md5, length(s.snapshot) AS total, "
        f"substr(s.snapshot, i * {int(size)} + 1, {int(size)}) AS chunk\n"
        f"FROM (\n{snapshot_sql}\n) s, generate_series({int(first)}, {int(last)}) AS i\n"
        f"WHERE i * {int(size)} < length(s.snapshot)\nORDER BY i"
    )


# ---------------------------------------------------------------- Aurora (read-only)

def fetch_aurora_snapshot(cluster: str, region: str, database: str,
                          secret_arn: Optional[str] = None,
                          chunk_size: int = 30000, chunks_per_call: int = 20) -> Dict[str, Any]:
    """Run the snapshot SELECT on Aurora through the RDS Data API. Read-only."""
    import boto3  # imported here so the pure diff and the tests need no boto3

    if region != EXPECTED_REGION:
        raise SnapshotError(f"region {region!r} is not {EXPECTED_REGION} (CLAUDE.md IF-THEN 11)")
    session = boto3.session.Session(region_name=region)
    account = session.client("sts").get_caller_identity()["Account"]
    if account != EXPECTED_ACCOUNT:
        raise SnapshotError(f"AWS account {account} is not {EXPECTED_ACCOUNT} (CLAUDE.md IF-THEN 11)")
    rds = session.client("rds")
    desc = rds.describe_db_clusters(DBClusterIdentifier=cluster)["DBClusters"][0]
    cluster_arn = desc["DBClusterArn"]
    if not secret_arn:
        secret_arn = (desc.get("MasterUserSecret") or {}).get("SecretArn")
    if not secret_arn:
        raise SnapshotError(f"cluster {cluster} has no MasterUserSecret; pass --secret-arn")
    data = session.client("rds-data")
    base_sql = read_snapshot_sql()

    rows: List[Dict[str, Any]] = []
    first, total = 0, None
    while True:
        last = first + chunks_per_call - 1
        res = data.execute_statement(resourceArn=cluster_arn, secretArn=secret_arn,
                                     database=database, sql=chunked_sql(base_sql, first, last, chunk_size))
        recs = res.get("records") or []
        for rec in recs:
            i, md5, tot, chunk = (rec[0]["longValue"], rec[1]["stringValue"],
                                  rec[2]["longValue"], rec[3]["stringValue"])
            total = tot
            if rows and rows[0]["md5"] != md5:
                raise SnapshotError("Aurora catalog changed while reading the snapshot; re-run")
            rows.append({"i": i, "md5": md5, "chunk": chunk})
        if total is None:
            raise SnapshotError("Aurora returned an empty snapshot")
        if (last + 1) * chunk_size >= total:
            break
        first = last + 1
    return normalize_snapshot(rows, "aurora")


# ---------------------------------------------------------------- diff

def _ext_objects(snaps: Iterable[Dict[str, Any]], key: str, ident) -> set:
    out = set()
    for snap in snaps:
        for row in snap.get(key) or []:
            if row.get("extension"):
                out.add(ident(row))
    return out


def _tbl(row):
    return (row.get("schema") or "public", row["table"])


def _rtn(row):
    return (row.get("schema") or "public", row.get("routine_signature") or
            f"{row['routine_name']}({row['routine_args']})")


def _grant_diff(sup_rows, aur_rows, keyfn, ext_ids, ident, include_ext):
    """Return (extra, missing, skipped_ext, ignored_version) as sorted row lists."""
    def index(rows):
        out = {}
        for r in rows:
            out[keyfn(r)] = r
        return out

    s, a = index(sup_rows), index(aur_rows)
    extra, missing, skipped, ignored = [], [], 0, []
    for side_keys, other, bucket, side in ((a, s, extra, "aurora"), (s, a, missing, "supabase")):
        for k, row in side_keys.items():
            if k in other:
                continue
            if not include_ext and ident(row) in ext_ids:
                skipped += 1
                continue
            if row["privilege"] in VERSION_SPECIFIC_PRIVILEGES:
                ignored.append(dict(row, only_on=side))
                continue
            bucket.append(row)
    keysort = lambda r: tuple(str(x) for x in keyfn(r))  # noqa: E731
    return sorted(extra, key=keysort), sorted(missing, key=keysort), skipped, ignored


def _parse_duration_ms(value: str) -> Optional[float]:
    m = re.match(r"^\s*(-?\d+(?:\.\d+)?)\s*([a-z]*)\s*$", value.strip().lower())
    if not m:
        return None
    num, unit = float(m.group(1)), m.group(2) or "ms"
    if unit not in _DURATION_UNITS:
        return None
    return num * _DURATION_UNITS[unit]


def normalize_setting_value(name: str, value: str) -> str:
    if name.lower() in DURATION_SETTINGS:
        ms = _parse_duration_ms(value)
        if ms is not None:
            return f"{ms:g}ms"
    return value.strip()


def _role_settings(snap) -> Dict[Tuple[str, str], Dict[str, Any]]:
    """(role, setting) -> {value, scopes}; a database-specific value overrides
    the all-databases one, as it does at session start."""
    out: Dict[Tuple[str, str], Dict[str, Any]] = {}
    rows = sorted(snap.get("role_settings") or [], key=lambda r: r.get("database") is not None)
    for row in rows:
        setting = row["setting"]
        if "=" not in setting:
            raise SnapshotError(f"role setting without '=': {setting!r}")
        name, value = setting.split("=", 1)
        key = (row["role"], name)
        entry = out.setdefault(key, {"value": None, "scopes": []})
        entry["value"] = value
        entry["scopes"].append(row.get("database"))
    return out


def _explode_default_acl(snap, role_map: Dict[str, str]):
    out = {}
    for row in snap.get("default_acl") or []:
        role = role_map.get(row["role"], row["role"])
        for priv in row.get("privileges") or []:
            key = (role, row.get("schema"), row["objtype"], row["grantee"], priv)
            out[key] = {"role": role, "schema": row.get("schema"), "objtype": row["objtype"],
                        "grantee": row["grantee"], "privilege": priv}
    return out


def diff(supabase: Dict[str, Any], aurora: Dict[str, Any], role_map: Optional[Dict[str, str]] = None,
         include_extension_objects: bool = False) -> Dict[str, Any]:
    """Pure comparison of two snapshots. EXTRA = Aurora has it, Supabase does not;
    MISSING = Supabase has it, Aurora does not. role_map renames Supabase
    default-ACL owner roles to their Aurora counterpart (postgres=vitana_admin)."""
    role_map = role_map or {}
    supabase = normalize_snapshot(supabase, "supabase")
    aurora = normalize_snapshot(aurora, "aurora")
    snaps = (supabase, aurora)
    result: Dict[str, Any] = {"ignored_version_specific": [], "skipped_extension_objects": {}}

    ext_tables = _ext_objects(snaps, "table_grants", _tbl) | _ext_objects(snaps, "rls", _tbl) \
        | _ext_objects(snaps, "column_grants", _tbl)
    ext_routines = _ext_objects(snaps, "routine_grants", _rtn)

    specs = (
        ("table_grants", lambda r: (*_tbl(r), r["grantee"], r["privilege"]), ext_tables, _tbl),
        ("column_grants", lambda r: (*_tbl(r), r["column"], r["grantee"], r["privilege"]), ext_tables, _tbl),
        ("routine_grants", lambda r: (*_rtn(r), r["grantee"], r["privilege"]), ext_routines, _rtn),
    )
    for key, keyfn, ext_ids, ident in specs:
        extra, missing, skipped, ignored = _grant_diff(
            supabase.get(key) or [], aurora.get(key) or [], keyfn, ext_ids, ident, include_extension_objects)
        result[key] = {"extra": extra, "missing": missing}
        result["skipped_extension_objects"][key] = skipped
        result["ignored_version_specific"] += [dict(r, kind=key) for r in ignored]

    # A table-level REVOKE also removes that privilege's column-level grants
    # (PostgreSQL semantics), so Supabase column grants hit by an EXTRA table
    # revoke must be granted again afterwards. Not a finding, only fix input.
    revoked = {(*_tbl(r), r["grantee"], r["privilege"]) for r in result["table_grants"]["extra"]}
    missing_cols = {(*_tbl(r), r["column"], r["grantee"], r["privilege"]) for r in result["column_grants"]["missing"]}
    result["column_grants"]["restore_after_table_revoke"] = sorted(
        (r for r in supabase.get("column_grants") or []
         if (*_tbl(r), r["grantee"], r["privilege"]) in revoked
         and (*_tbl(r), r["column"], r["grantee"], r["privilege"]) not in missing_cols),
        key=lambda r: (r["table"], r["column"], r["grantee"], r["privilege"]))

    # RLS
    s_rls = {_tbl(r): r for r in supabase["rls"]}
    a_rls = {_tbl(r): r for r in aurora["rls"]}
    mismatch, only_s, only_a, skipped = [], [], [], 0
    for k in sorted(set(s_rls) | set(a_rls)):
        if not include_extension_objects and k in ext_tables:
            skipped += 1
            continue
        if k not in a_rls:
            only_s.append({"schema": k[0], "table": k[1]})
        elif k not in s_rls:
            only_a.append({"schema": k[0], "table": k[1], "rls_enabled": bool(a_rls[k]["rls_enabled"]),
                           "rls_forced": bool(a_rls[k]["rls_forced"])})
        else:
            s, a = s_rls[k], a_rls[k]
            if bool(s["rls_enabled"]) != bool(a["rls_enabled"]) or bool(s["rls_forced"]) != bool(a["rls_forced"]):
                mismatch.append({"schema": k[0], "table": k[1],
                                 "supabase": {"rls_enabled": bool(s["rls_enabled"]), "rls_forced": bool(s["rls_forced"])},
                                 "aurora": {"rls_enabled": bool(a["rls_enabled"]), "rls_forced": bool(a["rls_forced"])}})
    result["rls"] = {"mismatch": mismatch, "only_on_supabase": only_s, "only_on_aurora": only_a}
    result["skipped_extension_objects"]["rls"] = skipped

    # Default privileges
    s_def = _explode_default_acl(supabase, role_map)
    a_def = _explode_default_acl(aurora, {})
    aurora_roles = set(aurora.get("roles") or [])
    d_extra, d_missing, d_na = [], [], []
    for k in sorted(set(a_def) - set(s_def), key=lambda t: tuple(str(x) for x in t)):
        row = a_def[k]
        if row["privilege"] in VERSION_SPECIFIC_PRIVILEGES:
            result["ignored_version_specific"].append(dict(row, kind="default_acl", only_on="aurora"))
        else:
            d_extra.append(row)
    for k in sorted(set(s_def) - set(a_def), key=lambda t: tuple(str(x) for x in t)):
        row = s_def[k]
        if row["privilege"] in VERSION_SPECIFIC_PRIVILEGES:
            result["ignored_version_specific"].append(dict(row, kind="default_acl", only_on="supabase"))
        elif aurora_roles and row["role"] not in aurora_roles:
            d_na.append(row)  # owner role does not exist on Aurora (e.g. supabase_admin)
        else:
            d_missing.append(row)
    result["default_acl"] = {"extra": d_extra, "missing": d_missing, "owner_role_absent_on_aurora": d_na}

    # Role settings
    s_set, a_set = _role_settings(supabase), _role_settings(aurora)
    rs_mismatch = []
    for role, name in sorted(set(s_set) | set(a_set)):
        s, a = s_set.get((role, name)), a_set.get((role, name))
        sv = normalize_setting_value(name, s["value"]) if s else None
        av = normalize_setting_value(name, a["value"]) if a else None
        if sv != av:
            rs_mismatch.append({"role": role, "name": name,
                                "supabase": s["value"] if s else None,
                                "aurora": a["value"] if a else None,
                                "aurora_scopes": a["scopes"] if a else []})
    result["role_settings"] = {"mismatch": rs_mismatch}

    # Role attributes (only when both snapshots carry them)
    attrs = ("rolsuper", "rolbypassrls", "rolinherit", "rolcanlogin")
    ra_mismatch, missing_roles = [], []
    if supabase.get("role_attributes") is not None and aurora.get("role_attributes") is not None:
        s_attr = {r["role"]: r for r in supabase["role_attributes"]}
        a_attr = {r["role"]: r for r in aurora["role_attributes"]}
        for role in sorted(set(s_attr) | set(API_ROLES)):
            if role not in s_attr:
                continue
            if role not in a_attr:
                missing_roles.append(role)
                continue
            for attr in attrs:
                if attr in s_attr[role] and bool(s_attr[role][attr]) != bool(a_attr[role].get(attr)):
                    ra_mismatch.append({"role": role, "attribute": attr,
                                        "supabase": bool(s_attr[role][attr]), "aurora": bool(a_attr[role].get(attr))})
    result["role_attributes"] = {"mismatch": ra_mismatch, "missing_roles": missing_roles}

    # Role memberships
    s_mem = {(r["role"], r["member_of"]) for r in supabase.get("role_memberships") or []}
    a_mem = {(r["role"], r["member_of"]) for r in aurora.get("role_memberships") or []}
    result["role_memberships"] = {
        "extra": [{"role": r, "member_of": m} for r, m in sorted(a_mem - s_mem)],
        "missing": [{"role": r, "member_of": m} for r, m in sorted(s_mem - a_mem)],
    }
    return result


def gate(result: Dict[str, Any], strict: bool = False) -> Tuple[List[str], List[str]]:
    """Return (failures, warnings) as human-readable counts."""
    fail, warn = [], []

    def add(bucket, n, text):
        if n:
            bucket.append(f"{n} {text}")

    for key in ("table_grants", "column_grants", "routine_grants"):
        add(fail, len(result[key]["extra"]), f"{key.replace('_', ' ')} EXTRA on Aurora")
        add(fail if strict else warn, len(result[key]["missing"]), f"{key.replace('_', ' ')} MISSING on Aurora")
    add(fail, len(result["rls"]["mismatch"]), "RLS mismatch(es)")
    add(fail if strict else warn, len(result["rls"]["only_on_supabase"]), "table(s) only on Supabase")
    add(warn, len(result["rls"]["only_on_aurora"]), "table(s) only on Aurora")
    add(fail, len(result["default_acl"]["extra"]), "default privilege(s) EXTRA on Aurora")
    add(fail if strict else warn, len(result["default_acl"]["missing"]), "default privilege(s) MISSING on Aurora")
    add(warn, len(result["default_acl"]["owner_role_absent_on_aurora"]),
        "Supabase default privilege(s) for owner roles absent on Aurora")
    add(fail, len(result["role_settings"]["mismatch"]), "role setting mismatch(es)")
    add(fail, len(result["role_attributes"]["mismatch"]), "role attribute mismatch(es)")
    add(fail, len(result["role_attributes"]["missing_roles"]), "API role(s) missing on Aurora")
    add(fail, len(result["role_memberships"]["extra"]), "role membership(s) EXTRA on Aurora")
    add(fail if strict else warn, len(result["role_memberships"]["missing"]), "role membership(s) MISSING on Aurora")
    add(warn, len(result["ignored_version_specific"]), "version-specific privilege difference(s) ignored")
    return fail, warn


# ---------------------------------------------------------------- fix SQL

def _on_relation(row) -> str:
    kind = RELKIND_OBJECT.get(row.get("relkind") or "", "TABLE")
    return f"{kind} {qualified(row.get('schema'), row['table'])}"


def _check_priv(priv: str, allowed) -> str:
    if priv not in allowed:
        raise SnapshotError(f"unexpected privilege {priv!r}")
    return priv


def _defacl_stmt(row, verb: str) -> str:
    objtype = DEFACL_OBJTYPES.get(row["objtype"])
    if not objtype:
        raise SnapshotError(f"unknown default-ACL object type {row['objtype']!r}")
    priv = _check_priv(row["privilege"], TABLE_PRIVILEGES | ROUTINE_PRIVILEGES | {"CREATE"})
    scope = f" IN SCHEMA {quote_ident(row['schema'])}" if row.get("schema") else ""
    prep = "TO" if verb == "GRANT" else "FROM"
    return (f"ALTER DEFAULT PRIVILEGES FOR ROLE {quote_ident(row['role'])}{scope} "
            f"{verb} {priv} ON {objtype} {prep} {quote_role(row['grantee'])};")


def fix_statements(result: Dict[str, Any], allow_loosen: bool = False) -> List[str]:
    """SQL that makes Aurora match Supabase. Tightening first (REVOKE, RLS on,
    settings), then MISSING grants. Changes that would make Aurora LESS
    restrictive than it is in a way Supabase also is (disable RLS, drop a
    setting) are emitted as comments unless allow_loosen."""
    tighten: List[str] = []
    grant: List[str] = []
    loosen: List[str] = []

    for row in result["table_grants"]["extra"]:
        tighten.append(f"REVOKE {_check_priv(row['privilege'], TABLE_PRIVILEGES)} ON {_on_relation(row)} "
                       f"FROM {quote_role(row['grantee'])};")
    for row in result["column_grants"]["extra"]:
        tighten.append(f"REVOKE {_check_priv(row['privilege'], TABLE_PRIVILEGES)} ({quote_ident(row['column'])}) "
                       f"ON TABLE {qualified(row.get('schema'), row['table'])} FROM {quote_role(row['grantee'])};")
    for row in result["routine_grants"]["extra"]:
        tighten.append(f"REVOKE {_check_priv(row['privilege'], ROUTINE_PRIVILEGES)} ON ROUTINE {routine_ref(row)} "
                       f"FROM {quote_role(row['grantee'])};")
    for row in result["role_memberships"]["extra"]:
        tighten.append(f"REVOKE {quote_ident(row['member_of'])} FROM {quote_ident(row['role'])};")
    for row in result["default_acl"]["extra"]:
        tighten.append(_defacl_stmt(row, "REVOKE"))

    for row in result["rls"]["mismatch"]:
        rel = qualified(row["schema"], row["table"])
        s, a = row["supabase"], row["aurora"]
        if s["rls_enabled"] and not a["rls_enabled"]:
            tighten.append(f"ALTER TABLE {rel} ENABLE ROW LEVEL SECURITY;")
        elif a["rls_enabled"] and not s["rls_enabled"]:
            loosen.append(f"ALTER TABLE {rel} DISABLE ROW LEVEL SECURITY;")
        if s["rls_forced"] and not a["rls_forced"]:
            tighten.append(f"ALTER TABLE {rel} FORCE ROW LEVEL SECURITY;")
        elif a["rls_forced"] and not s["rls_forced"]:
            loosen.append(f"ALTER TABLE {rel} NO FORCE ROW LEVEL SECURITY;")

    for row in result["role_settings"]["mismatch"]:
        role, name = quote_ident(row["role"]), row["name"]
        if not _SAFE_SETTING_NAME.match(name):
            raise SnapshotError(f"unsafe setting name {name!r}")
        db_scopes = [d for d in row["aurora_scopes"] if d]
        if row["supabase"] is not None:
            for db in db_scopes:  # a per-database value would override the role-wide one
                tighten.append(f"ALTER ROLE {role} IN DATABASE {quote_ident(db)} RESET {name};")
            tighten.append(f"ALTER ROLE {role} SET {name} = {quote_literal(row['supabase'])};")
        else:
            for db in db_scopes:
                loosen.append(f"ALTER ROLE {role} IN DATABASE {quote_ident(db)} RESET {name};")
            if None in row["aurora_scopes"]:
                loosen.append(f"ALTER ROLE {role} RESET {name};")

    keyword = {"rolbypassrls": ("BYPASSRLS", "NOBYPASSRLS"), "rolinherit": ("INHERIT", "NOINHERIT"),
               "rolcanlogin": ("LOGIN", "NOLOGIN"), "rolsuper": ("SUPERUSER", "NOSUPERUSER")}
    for row in result["role_attributes"]["mismatch"]:
        on, off = keyword[row["attribute"]]
        stmt = f"ALTER ROLE {quote_ident(row['role'])} {on if row['supabase'] else off};"
        if row["attribute"] == "rolsuper":
            tighten.append(f"-- MANUAL (RDS has no true superuser): {stmt}")
        else:
            tighten.append(stmt)

    for row in result["table_grants"]["missing"]:
        grant.append(f"GRANT {_check_priv(row['privilege'], TABLE_PRIVILEGES)} ON {_on_relation(row)} "
                     f"TO {quote_role(row['grantee'])};")
    for row in result["column_grants"]["missing"] + result["column_grants"].get("restore_after_table_revoke", []):
        grant.append(f"GRANT {_check_priv(row['privilege'], TABLE_PRIVILEGES)} ({quote_ident(row['column'])}) "
                     f"ON TABLE {qualified(row.get('schema'), row['table'])} TO {quote_role(row['grantee'])};")
    for row in result["routine_grants"]["missing"]:
        grant.append(f"GRANT {_check_priv(row['privilege'], ROUTINE_PRIVILEGES)} ON ROUTINE {routine_ref(row)} "
                     f"TO {quote_role(row['grantee'])};")
    for row in result["role_memberships"]["missing"]:
        grant.append(f"GRANT {quote_ident(row['member_of'])} TO {quote_ident(row['role'])};")
    for row in result["default_acl"]["missing"]:
        grant.append(_defacl_stmt(row, "GRANT"))

    out = tighten + grant
    if loosen:
        if allow_loosen:
            out += loosen
        else:
            out.append("-- The statements below make Aurora LESS restrictive to match Supabase.")
            out.append("-- Review each one; rerun with --allow-loosen to emit them uncommented.")
            out += ["-- " + s for s in loosen]
    return out


# ---------------------------------------------------------------- report

def _fmt_row(kind: str, row: Dict[str, Any]) -> str:
    if kind in ("table_grants", "column_grants"):
        col = f".{row['column']}" if "column" in row else ""
        return f"{row['privilege']:<10} {row['grantee']:<14} {row.get('schema') or 'public'}.{row['table']}{col}"
    if kind == "routine_grants":
        return f"{row['privilege']:<10} {row['grantee']:<14} {routine_ref(row)}"
    if kind == "default_acl":
        return (f"{row['privilege']:<10} {row['grantee']:<14} owner={row['role']} "
                f"schema={row.get('schema') or '(all)'} {DEFACL_OBJTYPES.get(row['objtype'], row['objtype'])}")
    if kind == "rls" and "supabase" in row:
        fmt = lambda d: f"enabled={d['rls_enabled']} forced={d['rls_forced']}"  # noqa: E731
        return f"{row['schema']}.{row['table']}: supabase {fmt(row['supabase'])} | aurora {fmt(row['aurora'])}"
    if kind == "role_settings":
        return f"{row['role']}.{row['name']}: supabase={row['supabase']!r} aurora={row['aurora']!r}"
    return json.dumps(row, sort_keys=True)


def render_report(result: Dict[str, Any], failures: List[str], warnings: List[str],
                  limit: int = 50) -> str:
    lines = ["Aurora privilege-parity gate (VTID-05023 part 0)",
             "EXTRA = Aurora grants it, Supabase does not.  MISSING = Supabase grants it, Aurora does not.", ""]

    def section(title, rows, kind):
        if not rows:
            return
        lines.append(f"{title} ({len(rows)})")
        for row in rows[:limit]:
            lines.append("  " + _fmt_row(kind, row))
        if len(rows) > limit:
            lines.append(f"  ... {len(rows) - limit} more in the JSON report")
        lines.append("")

    for key in ("table_grants", "column_grants", "routine_grants"):
        section(f"EXTRA {key}", result[key]["extra"], key)
        section(f"MISSING {key}", result[key]["missing"], key)
    section("RLS mismatch", result["rls"]["mismatch"], "rls")
    section("Tables only on Supabase", result["rls"]["only_on_supabase"], "rls")
    section("Tables only on Aurora", result["rls"]["only_on_aurora"], "rls")
    section("EXTRA default privileges", result["default_acl"]["extra"], "default_acl")
    section("MISSING default privileges", result["default_acl"]["missing"], "default_acl")
    section("Default privileges for owner roles absent on Aurora",
            result["default_acl"]["owner_role_absent_on_aurora"], "default_acl")
    section("Role setting mismatch", result["role_settings"]["mismatch"], "role_settings")
    section("Role attribute mismatch", result["role_attributes"]["mismatch"], "role_attributes")
    section("API roles missing on Aurora", [{"role": r} for r in result["role_attributes"]["missing_roles"]], "roles")
    section("EXTRA role memberships", result["role_memberships"]["extra"], "role_memberships")
    section("MISSING role memberships", result["role_memberships"]["missing"], "role_memberships")
    section("Ignored version-specific differences", result["ignored_version_specific"], "ignored")
    skipped = {k: v for k, v in result["skipped_extension_objects"].items() if v}
    if skipped:
        lines.append(f"Extension-owned objects not gated: {skipped} (use --include-extension-objects)")
        lines.append("")
    lines.append("RESULT: " + ("FAIL — " + "; ".join(failures) if failures else "PASS"))
    if warnings:
        lines.append("WARNINGS: " + "; ".join(warnings))
    return "\n".join(lines)


# ---------------------------------------------------------------- CLI

def _parse_role_map(items: List[str]) -> Dict[str, str]:
    out = {}
    for item in items or []:
        if "=" not in item:
            raise SnapshotError(f"--role-map expects supabase_role=aurora_role, got {item!r}")
        k, v = item.split("=", 1)
        out[k.strip()] = v.strip()
    return out


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0],
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--supabase-snapshot", help="Supabase snapshot JSON (output of the snapshot SQL)")
    p.add_argument("--aurora-snapshot", help="read Aurora's snapshot from this file instead of the Data API")
    p.add_argument("--save-aurora-snapshot", help="write the snapshot read from Aurora to this file")
    p.add_argument("--cluster", default=DEFAULT_CLUSTER, help="Aurora cluster id (use the clone first)")
    p.add_argument("--region", default=EXPECTED_REGION)
    p.add_argument("--database", default=DEFAULT_DATABASE)
    p.add_argument("--secret-arn", help="Data API secret (default: the cluster's MasterUserSecret)")
    p.add_argument("--check", action="store_true", help="report and gate (exit 1 on failure)")
    p.add_argument("--report", help="write the JSON report here")
    p.add_argument("--strict", action="store_true", help="MISSING grants fail the gate too")
    p.add_argument("--fix", action="store_true", help="write the fix SQL to --out (never executed)")
    p.add_argument("--out", help="fix SQL output path, for scripts/aws/aurora-run-sql.sh")
    p.add_argument("--allow-loosen", action="store_true",
                   help="emit RLS-disable / setting-reset statements uncommented")
    p.add_argument("--role-map", action="append", default=[],
                   help="map a Supabase default-ACL owner role to Aurora's, e.g. postgres=vitana_admin")
    p.add_argument("--include-extension-objects", action="store_true",
                   help="also gate objects that belong to an extension")
    p.add_argument("--limit", type=int, default=50, help="rows per section in the text report")
    p.add_argument("--print-chunk-sql", metavar="FIRST:LAST",
                   help="print the chunked snapshot SELECT (for clients with small result limits) and exit")
    return p


def main(argv: Optional[List[str]] = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        if args.print_chunk_sql:
            first, last = (int(x) for x in args.print_chunk_sql.split(":"))
            print(chunked_sql(read_snapshot_sql(), first, last))
            return 0
        if not (args.check or args.fix):
            print("error: pass --check and/or --fix", file=sys.stderr)
            return 2
        if args.fix and not args.out:
            print("error: --fix needs --out", file=sys.stderr)
            return 2
        if not args.supabase_snapshot:
            print("error: --supabase-snapshot is required", file=sys.stderr)
            return 2
        supabase = load_snapshot(args.supabase_snapshot, "supabase")
        if args.aurora_snapshot:
            aurora = load_snapshot(args.aurora_snapshot, "aurora")
            aurora_source = args.aurora_snapshot
        else:
            aurora = fetch_aurora_snapshot(args.cluster, args.region, args.database, args.secret_arn)
            aurora_source = f"rds-data:{args.cluster}/{args.database}"
            if args.save_aurora_snapshot:
                with open(args.save_aurora_snapshot, "w", encoding="utf-8") as fh:
                    json.dump(aurora, fh, indent=1, sort_keys=True)
        result = diff(supabase, aurora, _parse_role_map(args.role_map), args.include_extension_objects)
        failures, warnings = gate(result, args.strict)
        statements = fix_statements(result, args.allow_loosen) if args.fix else None
    except SnapshotError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    if args.check:
        print(render_report(result, failures, warnings, args.limit))
        if args.report:
            report = {"generated_at": _dt.datetime.now(_dt.timezone.utc).isoformat(timespec="seconds"),
                      "supabase_source": args.supabase_snapshot, "aurora_source": aurora_source,
                      "strict": args.strict, "ok": not failures, "failures": failures,
                      "warnings": warnings, "findings": result}
            with open(args.report, "w", encoding="utf-8") as fh:
                json.dump(report, fh, indent=1, sort_keys=True)
    if args.fix:
        real = [s for s in statements if not s.startswith("--")]
        header = [f"-- Aurora privilege-parity fix (VTID-05023 part 0), generated "
                  f"{_dt.datetime.now(_dt.timezone.utc).isoformat(timespec='seconds')}",
                  f"-- Supabase: {args.supabase_snapshot}  Aurora: {aurora_source}",
                  f"-- {len(real)} statement(s). Run: scripts/aws/aurora-run-sql.sh <this file>",
                  "-- Then re-run --check: a REVOKE by a non-owner/non-grantor is a silent no-op."]
        with open(args.out, "w", encoding="utf-8") as fh:
            fh.write("\n".join(header + statements) + "\n")
        print(f"fix SQL: {len(real)} statement(s) written to {args.out}", file=sys.stderr)
    return 1 if (args.check and failures) else 0


if __name__ == "__main__":
    sys.exit(main())
