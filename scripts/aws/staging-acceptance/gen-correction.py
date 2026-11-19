#!/usr/bin/env python3
# VTID-05803 schema-acceptance correction generator (acceptance owner, Kiro 5).
#
# Runs INSIDE the existing vitana-aurora-staging-migrate task AFTER k5.py has written /w/out/a07-diff.txt (the
# authoritative per-object A07 diff for current staging vs LIVE source). It reads that, then reconstructs the DDL for
# EXACTLY the flagged missing/changed objects from the LIVE SOURCE catalog using server-side functions only
# (pg_get_functiondef / pg_get_constraintdef / pg_get_indexdef / format_type / pg_get_expr / pg_policy) — never pg_dump,
# whose client is older than the PG17 source. It writes nothing to any database; it only emits an ADDITIVE,
# non-destructive /w/out/correction.sql. The apply step runs that in one transaction and re-verifies with k5.py.
#
# Additive only: CREATE SEQUENCE IF NOT EXISTS / CREATE OR REPLACE FUNCTION / CREATE TABLE IF NOT EXISTS /
# ALTER TABLE ... ADD / CREATE INDEX IF NOT EXISTS / GRANT / ENABLE ROW LEVEL SECURITY / CREATE POLICY /
# CREATE EXTENSION IF NOT EXISTS / CREATE TRIGGER. Grants/policies are filtered to roles present on staging (grants to
# source-only roles are the ones k5.py already allowlists). No DROP/TRUNCATE/DELETE/REVOKE/INSERT/UPDATE.
import os, re, subprocess as S, sys, urllib.parse as U
W = os.environ.get("K5_W", "/w"); O = W + "/out"; DIFF = O + "/a07-diff.txt"; OUT = O + "/correction.sql"

def ql(s):  # SQL string literal
    return "'" + str(s).replace("'", "''") + "'"

def conn_env(host, port, user, pw, db):
    e = {k: v for k, v in os.environ.items() if not k.startswith(("PG", "SOURCE_URI"))}
    e.update(PGHOST=host, PGPORT=str(port), PGUSER=user, PGPASSWORD=pw, PGDATABASE=db,
             PGSSLMODE=os.environ.get("K5_SSLMODE", "require"), PGCONNECT_TIMEOUT="20",
             PGOPTIONS="-c default_transaction_read_only=on -c statement_timeout=900000")
    return e

def src_env():
    r = re.sub(r"^postgres(ql)?://", "", os.environ["SOURCE_URI"])
    cr, _, hp = r.rpartition("@"); su, _, sw = cr.partition(":"); hp, _, pq = hp.partition("/")
    sd = pq.split("?")[0] or "postgres"
    sh, _, sp = hp.rpartition(":") if hp.count(":") == 1 else (hp, "", "")
    return conn_env(sh, int(sp or 5432), U.unquote(su), U.unquote(sw), sd)

def q(env, sql, sep="\x1f"):
    # At, tuples-only, field sep \x1f, record sep \x1e so multi-line defs survive.
    p = S.run(["psql", "-X", "-q", "-At", "-F", sep, "-R", "\x1e", "-v", "ON_ERROR_STOP=1",
               "-c", "SET SESSION default_transaction_read_only = on", "-c", sql],
              env=env, capture_output=True, text=True)
    if p.returncode:
        sys.stderr.write("psql error: %s\nSQL: %s\n" % (p.stderr[-500:], sql[:200])); sys.exit(2)
    rows = [r for r in p.stdout.split("\x1e") if r != ""]
    return [r.split(sep) for r in rows]

SRC = src_env()
STG = conn_env(os.environ["PGHOST"], os.environ.get("PGPORT", "5432"), os.environ["PGUSER"],
               os.environ["PGPASSWORD"], os.environ.get("K5_DB", "vitana"))
roles = set(r[0] for r in q(STG, "select rolname from pg_roles") if r and r[0])
sys.stderr.write("staging roles=%d\n" % len(roles))

# ---- parse the flagged objects from a07-diff.txt ----
miss_tables, funcs, exts, miss_idx, add_cols, add_cons = [], [], [], [], [], []
fseen = set()
for raw in open(DIFF):
    raw = raw.rstrip("\n")
    m = re.match(r"^(missing|changed) (\w+)\|(.+?)(?: (?:source|staging)=.*)?$", raw)
    if not m:
        continue
    status, cat, name = m.group(1), m.group(2), m.group(3).strip()
    if cat == "table" and status == "missing":
        miss_tables.append(name)
    elif cat == "function":
        if name not in fseen:
            fseen.add(name); funcs.append(name)
    elif cat == "extension":
        exts.append(name.split("|")[0])
    elif cat == "index" and status == "missing":
        miss_idx.append(name)
    elif cat == "column" and status == "missing":
        add_cols.append(name)
    elif cat in ("check", "fk", "unique", "primary_key") and status == "missing":
        add_cons.append((cat, name))
miss_tables = sorted(set(miss_tables))
tset = set(miss_tables)
# objects that belong to a missing table are created by the table block; keep only the "other-table" extras.
oth_idx = [i for i in miss_idx]
oth_cols = [c for c in add_cols if c.split(".")[0] not in tset]
oth_cons = [(cat, n) for (cat, n) in add_cons if n.split(".")[0] not in tset]
sys.stderr.write("flagged: tables=%d funcs=%d exts=%d other-idx=%d other-cols=%d other-cons=%d\n"
                 % (len(miss_tables), len(funcs), len(exts), len(oth_idx), len(oth_cols), len(oth_cons)))

P = ["-- VTID-05803 additive schema correction (generated from live source; additive only).",
     "SET statement_timeout=900000;", "SET client_min_messages=warning;", ""]

# ---- 1. extensions ----
if exts:
    P.append("-- extensions")
    for r in q(SRC, "select e.extname, n.nspname from pg_extension e join pg_namespace n on n.oid=e.extnamespace "
                    "where e.extname = any(string_to_array(%s,','))" % ql(",".join(sorted(set(exts))))):
        if len(r) >= 2 and r[0]:
            P.append('CREATE EXTENSION IF NOT EXISTS "%s" WITH SCHEMA "%s";' % (r[0], r[1]))
    P.append("")

# ---- 2. sequences owned by / used by the missing tables (must exist before the table defaults) ----
if miss_tables:
    P.append("-- sequences for the missing tables")
    seqs = q(SRC,
        "select distinct s.relname from pg_class s join pg_depend d on d.objid=s.oid and d.classid='pg_class'::regclass "
        "join pg_class t on t.oid=d.refobjid join pg_namespace n on n.oid=t.relnamespace "
        "where s.relkind='S' and n.nspname='public' and t.relname = any(string_to_array(%s,','))"
        % ql(",".join(miss_tables)))
    for r in seqs:
        if r and r[0]:
            P.append('CREATE SEQUENCE IF NOT EXISTS public."%s";' % r[0])
    P.append("")

# ---- 3. functions (missing + changed): CREATE OR REPLACE from source ----
if funcs:
    P.append("-- functions (CREATE OR REPLACE from source)")
    defs = q(SRC,
        "select pg_get_functiondef(p.oid) from pg_proc p join pg_namespace n on n.oid=p.pronamespace "
        "where n.nspname='public' and "
        "(p.proname||'('||pg_get_function_identity_arguments(p.oid)||')') = any(string_to_array(%s, e'\\n'))"
        % ql("\n".join(funcs)))
    n = 0
    for r in defs:
        d = r[0].strip()
        if d:
            P.append(d if d.endswith(";") else d + ";"); n += 1
    sys.stderr.write("functions emitted=%d (flagged=%d)\n" % (n, len(funcs)))
    P.append("")

# ---- 4. missing tables: columns, then constraints, then indexes, then grants, then RLS/policies, then triggers ----
def ident(name):
    return 'public."%s"' % name

fk_lines = []
for t in miss_tables:
    P.append("-- table %s" % t)
    cols = q(SRC,
        "select a.attname, pg_catalog.format_type(a.atttypid,a.atttypmod), a.attnotnull, pg_get_expr(ad.adbin, ad.adrelid), a.attidentity "
        "from pg_attribute a left join pg_attrdef ad on ad.adrelid=a.attrelid and ad.adnum=a.attnum "
        "where a.attrelid=('public.'||%s)::regclass and a.attnum>0 and not a.attisdropped order by a.attnum" % ql(t))
    defs = []
    for c in cols:
        nm, typ, notnull, dflt, ident_ = (c + ["", "", "", "", ""])[:5]
        d = '  "%s" %s' % (nm, typ)
        if ident_ in ("a", "d"):
            d += " GENERATED %s AS IDENTITY" % ("ALWAYS" if ident_ == "a" else "BY DEFAULT")
        elif dflt:
            d += " DEFAULT %s" % dflt
        if notnull == "t":
            d += " NOT NULL"
        defs.append(d)
    P.append("CREATE TABLE IF NOT EXISTS %s (\n%s\n);" % (ident(t), ",\n".join(defs)))
    # constraints: PK/UNIQUE/CHECK first, FKs last (deferred to end of file so referenced tables exist)
    cons = q(SRC,
        "select conname, contype, pg_get_constraintdef(oid) from pg_constraint "
        "where conrelid=('public.'||%s)::regclass order by (contype='f'), conname" % ql(t))
    for cn in cons:
        if len(cn) < 3:
            continue
        name, ctype, cdef = cn[0], cn[1], cn[2]
        line = 'ALTER TABLE %s ADD CONSTRAINT "%s" %s;' % (ident(t), name, cdef)
        if ctype == "f":
            fk_lines.append(line)
        else:
            P.append(line)
    # indexes (those not backing a constraint)
    idx = q(SRC,
        "select indexname, indexdef from pg_indexes where schemaname='public' and tablename=%s "
        "and indexname not in (select conname from pg_constraint where conrelid=('public.'||%s)::regclass)"
        % (ql(t), ql(t)))
    for ix in idx:
        if len(ix) >= 2 and ix[1]:
            P.append(re.sub(r"^CREATE (UNIQUE )?INDEX ", lambda m: "CREATE %sINDEX IF NOT EXISTS " % (m.group(1) or ""), ix[1]) + ";")
    # grants (table + its sequences), roles filtered
    gr = q(SRC,
        "select c.relname, (select rolname from pg_roles where oid=aa.grantee), aa.privilege_type, c.relkind "
        "from pg_class c join pg_namespace n on n.oid=c.relnamespace, lateral aclexplode(c.relacl) aa "
        "where n.nspname='public' and c.relkind in ('r','p','S') and "
        "(c.relname=%s or c.oid in (select d.objid from pg_depend d join pg_class t2 on t2.oid=d.refobjid "
        "   join pg_namespace n2 on n2.oid=t2.relnamespace where n2.nspname='public' and t2.relname=%s and d.classid='pg_class'::regclass)) "
        "order by 1,2,3" % (ql(t), ql(t)))
    for g in gr:
        rel, role, priv, kind = (g + ["", "", "", ""])[:4]
        if not role or role not in roles:
            continue
        obj = ('SEQUENCE %s' % ident(rel)) if kind == "S" else ('TABLE %s' % ident(rel))
        P.append('GRANT %s ON %s TO "%s";' % (priv, obj, role))
    # RLS + policies
    rls = q(SRC, "select relrowsecurity, relforcerowsecurity from pg_class where oid=('public.'||%s)::regclass" % ql(t))
    if rls and rls[0] and rls[0][0] == "t":
        P.append("ALTER TABLE %s ENABLE ROW LEVEL SECURITY;" % ident(t))
    pol = q(SRC,
        "select polname, case when polpermissive then 'PERMISSIVE' else 'RESTRICTIVE' end, polcmd, "
        "pg_get_expr(polqual,polrelid), pg_get_expr(polwithcheck,polrelid), "
        "(select string_agg(rolname,',') from pg_roles where oid=any(polroles)) "
        "from pg_policy where polrelid=('public.'||%s)::regclass" % ql(t))
    cmap = {"r": "SELECT", "a": "INSERT", "w": "UPDATE", "d": "DELETE", "*": "ALL"}
    for pr in pol:
        if len(pr) < 6:
            continue
        pn, perm, cmd, qual, wc, prs = pr[0], pr[1], pr[2], pr[3], pr[4], pr[5]
        rl = [x for x in (prs or "").split(",") if x]
        if rl and not all(x in roles for x in rl):
            P.append("-- SKIP policy %s on %s (role absent on staging: %s)" % (pn, t, prs)); continue
        rc = "TO " + ",".join('"%s"' % x for x in rl) if rl else "TO public"
        s = 'CREATE POLICY "%s" ON %s AS %s FOR %s %s' % (pn, ident(t), perm, cmap.get(cmd, "ALL"), rc)
        if qual:
            s += " USING (%s)" % qual
        if wc:
            s += " WITH CHECK (%s)" % wc
        P.append(s + ";")
    # triggers
    trg = q(SRC, "select pg_get_triggerdef(oid) from pg_trigger where tgrelid=('public.'||%s)::regclass and not tgisinternal" % ql(t))
    for tr in trg:
        if tr and tr[0]:
            P.append(tr[0] + ";")
    P.append("")

# ---- 5. other-table additive bits (columns / constraints / indexes on already-present tables) ----
if oth_cols or oth_cons or oth_idx:
    P.append("-- additions on already-present tables")
    for col in sorted(set(oth_cols)):
        tbl, _, cn = col.partition(".")
        r = q(SRC,
            "select pg_catalog.format_type(a.atttypid,a.atttypmod), a.attnotnull, pg_get_expr(ad.adbin, ad.adrelid) "
            "from pg_attribute a left join pg_attrdef ad on ad.adrelid=a.attrelid and ad.adnum=a.attnum "
            "where a.attrelid=('public.'||%s)::regclass and a.attname=%s and not a.attisdropped" % (ql(tbl), ql(cn)))
        if r and len(r[0]) >= 1:
            typ, nn, df = (r[0] + ["", "", ""])[:3]
            d = 'ALTER TABLE %s ADD COLUMN IF NOT EXISTS "%s" %s' % (ident(tbl), cn, typ)
            if df:
                d += " DEFAULT %s" % df
            if nn == "t":
                d += " NOT NULL"
            P.append(d + ";")
    for (cat, n) in oth_cons:
        tbl, _, cn = n.partition(".")
        r = q(SRC, "select pg_get_constraintdef(oid) from pg_constraint where conrelid=('public.'||%s)::regclass and conname=%s" % (ql(tbl), ql(cn)))
        if r and r[0] and r[0][0]:
            (fk_lines if cat == "fk" else P).append('ALTER TABLE %s ADD CONSTRAINT "%s" %s;' % (ident(tbl), cn, r[0][0]))
    for ixname in sorted(set(oth_idx)):
        r = q(SRC, "select indexdef from pg_indexes where schemaname='public' and indexname=%s" % ql(ixname))
        if r and r[0] and r[0][0]:
            P.append(re.sub(r"^CREATE (UNIQUE )?INDEX ", lambda m: "CREATE %sINDEX IF NOT EXISTS " % (m.group(1) or ""), r[0][0]) + ";")
    P.append("")

# FKs last (after all tables exist)
if fk_lines:
    P.append("-- foreign keys (added last, after all referenced tables exist)")
    P += fk_lines
    P.append("")

open(OUT, "w").write("\n".join(P) + "\n")
sys.stderr.write("wrote %s (%d bytes)\n" % (OUT, os.path.getsize(OUT)))
print(OUT)
