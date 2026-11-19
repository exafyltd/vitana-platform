#!/usr/bin/env python3
# VTID-05803 schema-acceptance correction generator (acceptance owner, Kiro 5).
#
# Runs INSIDE the existing vitana-aurora-staging-migrate task AFTER k5.py wrote /w/out/a07-diff.txt (the authoritative
# per-object A07 diff, current staging vs LIVE source). It reconstructs an ADDITIVE, Aurora-applicable correction.sql for
# exactly the flagged objects, from the LIVE SOURCE catalog, using server-side functions only (never pg_dump — its client
# is older than the PG17 source). It writes nothing to any database; apply runs the SQL in one transaction + re-verifies.
#
# Additive only: CREATE SEQUENCE/TABLE IF NOT EXISTS, CREATE OR REPLACE FUNCTION/VIEW, ALTER TABLE ... ADD, CREATE INDEX
# IF NOT EXISTS, GRANT, ENABLE ROW LEVEL SECURITY, CREATE POLICY, CREATE TRIGGER. No DROP/TRUNCATE/DELETE/REVOKE/INSERT/
# UPDATE at top level. Grants/policies filtered to roles present on staging.
#
# Deliberately SKIPPED (platform-expected differences that cannot be applied additively on Aurora; left as residual for
# the acceptance owner to reconcile, NOT silently forced): extensions (pg_net/pgmq/supabase_vault are Supabase-only and
# not installable on Aurora; vector is a newer version on staging), the `public` schema owner, materialized views, and
# "changed" constraints on already-present tables (would need a destructive drop+recreate). K5_SCOPE=tables emits only the
# 6 tables (+deps); default/all also emits the function CREATE OR REPLACE set.
import os, re, subprocess as S, sys, urllib.parse as U
W = os.environ.get("K5_W", "/w"); O = W + "/out"; DIFF = O + "/a07-diff.txt"; OUT = O + "/correction.sql"
SCOPE = os.environ.get("K5_SCOPE", "all")

def ql(s):
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

def q(env, sql):
    p = S.run(["psql", "-X", "-q", "-At", "-F", "\x1f", "-R", "\x1e", "-v", "ON_ERROR_STOP=1",
               "-c", "SET SESSION default_transaction_read_only = on", "-c", sql],
              env=env, capture_output=True, text=True)
    if p.returncode:
        sys.stderr.write("psql error: %s\nSQL: %s\n" % (p.stderr[-600:], sql[:300])); sys.exit(2)
    return [r.split("\x1f") for r in p.stdout.split("\x1e") if r != ""]

SRC = src_env()
STG = conn_env(os.environ["PGHOST"], os.environ.get("PGPORT", "5432"), os.environ["PGUSER"],
               os.environ["PGPASSWORD"], os.environ.get("K5_DB", "vitana"))
roles = set(r[0] for r in q(STG, "select rolname from pg_roles") if r and r[0])
sys.stderr.write("staging roles=%d scope=%s\n" % (len(roles), SCOPE))

# ---- parse flagged objects ----
miss_tables, funcs, miss_idx, views, miss_seqs = [], [], [], [], []
fseen = set()
for raw in open(DIFF):
    raw = raw.rstrip("\n")
    m = re.match(r"^(missing|changed) (\w+)\|(.+?)(?: (?:source|staging)=.*)?$", raw)
    if not m:
        continue
    status, cat, name = m.group(1), m.group(2), m.group(3).strip()
    if cat == "table" and status == "missing":
        miss_tables.append(name)
    elif cat == "function" and name not in fseen:
        fseen.add(name); funcs.append(name)
    elif cat == "index" and status == "missing":
        miss_idx.append(name)
    elif cat == "view":
        views.append(name)
    elif cat == "sequence" and status == "missing":
        miss_seqs.append(name)
miss_tables = sorted(set(miss_tables)); tset = set(miss_tables)
sys.stderr.write("flagged: tables=%d funcs=%d views=%d idx=%d seqs=%d\n" % (len(miss_tables), len(funcs), len(views), len(miss_idx), len(miss_seqs)))

def ident(name):
    return 'public."%s"' % name

seqs, tbl_lines, idx_lines, rls_lines, fn_lines, pol_lines, trg_lines, view_lines, grant_lines, fgrant_lines, seqown_lines, fk_lines = ([] for _ in range(12))

# ---- sequences: those named missing in the diff + those owned by the 6 tables, reconstructed with full attributes
# (so CREATE TABLE column defaults referencing e.g. global_vtid_seq do not fail). OWNED BY is deferred until after tables.
seq_names = set(miss_seqs)
if miss_tables:
    for r in q(SRC, "select distinct s.relname from pg_class s join pg_depend d on d.objid=s.oid and d.classid='pg_class'::regclass "
                    "join pg_class t on t.oid=d.refobjid join pg_namespace n on n.oid=t.relnamespace "
                    "where s.relkind='S' and n.nspname='public' and t.relname = any(string_to_array(%s,','))" % ql(",".join(miss_tables))):
        if r and r[0]:
            seq_names.add(r[0])
for sname in sorted(seq_names):
    r = q(SRC, "select pg_catalog.format_type(seqtypid,null), seqstart, seqincrement, seqmin, seqmax, seqcache, seqcycle from pg_sequence where seqrelid=('public.'||%s)::regclass" % ql(sname))
    if r and r[0] and len(r[0]) >= 7:
        typ, start, inc, mn, mx, cache, cyc = r[0][:7]
        seqs.append('CREATE SEQUENCE IF NOT EXISTS public."%s" AS %s INCREMENT BY %s MINVALUE %s MAXVALUE %s START WITH %s CACHE %s %s;'
                    % (sname, typ, inc, mn, mx, start, cache, "CYCLE" if cyc == "t" else "NO CYCLE"))
    else:
        seqs.append('CREATE SEQUENCE IF NOT EXISTS public."%s";' % sname)
    ob = q(SRC, "select t.relname, a.attname from pg_depend d join pg_class s on s.oid=d.objid join pg_class t on t.oid=d.refobjid "
                "join pg_attribute a on a.attrelid=t.oid and a.attnum=d.refobjsubid where s.relkind='S' and s.relname=%s and d.deptype in ('a','i')" % ql(sname))
    if ob and ob[0] and len(ob[0]) >= 2 and ob[0][0] and ob[0][0] in tset:
        seqown_lines.append('ALTER SEQUENCE public."%s" OWNED BY public."%s"."%s";' % (sname, ob[0][0], ob[0][1]))

# ---- the 6 tables: columns, PK/unique/check (FKs deferred), indexes, RLS, grants, policies, triggers ----
for t in miss_tables:
    cols = q(SRC, "select a.attname, pg_catalog.format_type(a.atttypid,a.atttypmod), a.attnotnull, pg_get_expr(ad.adbin,ad.adrelid), a.attidentity "
                  "from pg_attribute a left join pg_attrdef ad on ad.adrelid=a.attrelid and ad.adnum=a.attnum "
                  "where a.attrelid=('public.'||%s)::regclass and a.attnum>0 and not a.attisdropped order by a.attnum" % ql(t))
    defs = []
    for c in cols:
        nm, typ, notnull, dflt, idn = (c + ["", "", "", "", ""])[:5]
        d = '  "%s" %s' % (nm, typ)
        if idn in ("a", "d"):
            d += " GENERATED %s AS IDENTITY" % ("ALWAYS" if idn == "a" else "BY DEFAULT")
        elif dflt:
            d += " DEFAULT %s" % dflt
        if notnull == "t":
            d += " NOT NULL"
        defs.append(d)
    tbl_lines.append("CREATE TABLE IF NOT EXISTS %s (\n%s\n);" % (ident(t), ",\n".join(defs)))
    for cn in q(SRC, "select conname, contype, pg_get_constraintdef(oid) from pg_constraint where conrelid=('public.'||%s)::regclass order by (contype='f'), conname" % ql(t)):
        if len(cn) < 3:
            continue
        name, ctype, cdef = cn[0], cn[1], cn[2]
        (fk_lines if ctype == "f" else tbl_lines).append('ALTER TABLE %s ADD CONSTRAINT "%s" %s;' % (ident(t), name, cdef))
    for ix in q(SRC, "select indexdef from pg_indexes where schemaname='public' and tablename=%s and indexname not in (select conname from pg_constraint where conrelid=('public.'||%s)::regclass)" % (ql(t), ql(t))):
        if ix and ix[0]:
            idx_lines.append(re.sub(r"^CREATE (UNIQUE )?INDEX ", lambda mm: "CREATE %sINDEX IF NOT EXISTS " % (mm.group(1) or ""), ix[0]) + ";")
    rls = q(SRC, "select relrowsecurity from pg_class where oid=('public.'||%s)::regclass" % ql(t))
    if rls and rls[0] and rls[0][0] == "t":
        rls_lines.append("ALTER TABLE %s ENABLE ROW LEVEL SECURITY;" % ident(t))
    for g in q(SRC, "select c.relname,(select rolname from pg_roles where oid=aa.grantee),aa.privilege_type,c.relkind "
                    "from pg_class c join pg_namespace n on n.oid=c.relnamespace, lateral aclexplode(c.relacl) aa "
                    "where n.nspname='public' and c.relkind in('r','p','S') and (c.relname=%s or c.oid in "
                    "(select d.objid from pg_depend d join pg_class t2 on t2.oid=d.refobjid join pg_namespace n2 on n2.oid=t2.relnamespace "
                    "where n2.nspname='public' and t2.relname=%s and d.classid='pg_class'::regclass)) order by 1,2,3" % (ql(t), ql(t))):
        rel, role, priv, kind = (g + ["", "", "", ""])[:4]
        if role and role in roles:
            grant_lines.append('GRANT %s ON %s public."%s" TO "%s";' % (priv, "SEQUENCE" if kind == "S" else "TABLE", rel, role))
    # column-level grants on the table (diff category column_grant)
    for cg in q(SRC, "select a.attname,(select rolname from pg_roles where oid=aa.grantee),aa.privilege_type "
                     "from pg_attribute a, lateral aclexplode(a.attacl) aa where a.attrelid=('public.'||%s)::regclass and a.attacl is not null order by 1,2,3" % ql(t)):
        col, role, priv = (cg + ["", "", ""])[:3]
        if role and role in roles:
            grant_lines.append('GRANT %s ("%s") ON TABLE %s TO "%s";' % (priv, col, ident(t), role))
    cmap = {"r": "SELECT", "a": "INSERT", "w": "UPDATE", "d": "DELETE", "*": "ALL"}
    for pr in q(SRC, "select polname, case when polpermissive then 'PERMISSIVE' else 'RESTRICTIVE' end, polcmd, pg_get_expr(polqual,polrelid), pg_get_expr(polwithcheck,polrelid), (select string_agg(rolname,',') from pg_roles where oid=any(polroles)) from pg_policy where polrelid=('public.'||%s)::regclass" % ql(t)):
        if len(pr) < 6:
            continue
        pn, perm, cmd, qual, wc, prs = pr[:6]
        rl = [x for x in (prs or "").split(",") if x]
        if rl and not all(x in roles for x in rl):
            pol_lines.append("-- SKIP policy %s on %s (role absent on staging: %s)" % (pn, t, prs)); continue
        rc = "TO " + ",".join('"%s"' % x for x in rl) if rl else "TO public"
        s = 'CREATE POLICY "%s" ON %s AS %s FOR %s %s' % (pn, ident(t), perm, cmap.get(cmd, "ALL"), rc)
        if qual:
            s += " USING (%s)" % qual
        if wc:
            s += " WITH CHECK (%s)" % wc
        pol_lines.append(s + ";")
    for tr in q(SRC, "select pg_get_triggerdef(oid) from pg_trigger where tgrelid=('public.'||%s)::regclass and not tgisinternal" % ql(t)):
        if tr and tr[0]:
            trg_lines.append(tr[0].rstrip(";") + ";")

# ---- functions (missing + changed): CREATE OR REPLACE, normal/procedure only (pg_get_functiondef errors on aggregates) ----
if funcs and SCOPE != "tables":
    rows = q(SRC, "select pg_get_functiondef(p.oid) from pg_proc p join pg_namespace n on n.oid=p.pronamespace "
                  "where n.nspname='public' and p.prokind in ('f','p') and "
                  "(p.proname||'('||pg_get_function_identity_arguments(p.oid)||')') = any(string_to_array(%s, e'\\n'))" % ql("\n".join(funcs)))
    for r in rows:
        d = r[0].strip()
        if d:
            fn_lines.append(d if d.endswith(";") else d + ";")
    sys.stderr.write("functions emitted=%d of %d flagged (aggregates/window skipped)\n" % (len(fn_lines), len(funcs)))
    # function-level grants (diff category function_grant) for the flagged functions, roles filtered
    for fg in q(SRC, "select p.proname||'('||pg_get_function_identity_arguments(p.oid)||')',(select rolname from pg_roles where oid=aa.grantee),aa.privilege_type "
                     "from pg_proc p join pg_namespace n on n.oid=p.pronamespace, lateral aclexplode(p.proacl) aa "
                     "where n.nspname='public' and p.prokind in('f','p') and p.proacl is not null and "
                     "(p.proname||'('||pg_get_function_identity_arguments(p.oid)||')') = any(string_to_array(%s, e'\\n')) order by 1,2,3" % ql("\n".join(funcs))):
        sig, role, priv = (fg + ["", "", ""])[:3]
        if role and role in roles:
            fgrant_lines.append('GRANT %s ON FUNCTION public.%s TO "%s";' % (priv, sig, role))

# ---- views (missing + changed): CREATE OR REPLACE VIEW from source ----
for v in sorted(set(views)):
    r = q(SRC, "select pg_get_viewdef(('public.'||%s)::regclass, true), (select array_to_string(reloptions,',') from pg_class where oid=('public.'||%s)::regclass) from pg_class where oid=('public.'||%s)::regclass" % (ql(v), ql(v), ql(v)))
    if r and r[0] and r[0][0]:
        vdef, opts = (r[0] + ["", ""])[:2]
        with_opts = " WITH (%s)" % opts if opts else ""
        view_lines.append('CREATE OR REPLACE VIEW %s%s AS\n%s' % (ident(v), with_opts, vdef if vdef.rstrip().endswith(";") else vdef.rstrip() + ";"))

P = ["-- VTID-05803 additive schema correction (generated from live source; additive only; Aurora-applicable subset).",
     "SET statement_timeout=900000;", "SET client_min_messages=warning;", ""]
def section(title, lines):
    if lines:
        P.append("-- " + title); P.extend(lines); P.append("")
section("sequences", seqs)
section("tables (columns, keys, checks)", tbl_lines)
section("sequence ownership", seqown_lines)
section("indexes", idx_lines)
section("row-level security", rls_lines)
section("functions (CREATE OR REPLACE from source)", fn_lines)
section("policies", pol_lines)
section("triggers", trg_lines)
section("views", view_lines)
section("table/column grants (roles present on staging)", grant_lines)
section("function grants (roles present on staging)", fgrant_lines)
section("foreign keys (last, after all tables exist)", fk_lines)

open(OUT, "w").write("\n".join(P) + "\n")
sys.stderr.write("wrote %s (%d bytes, %d statements)\n" % (OUT, os.path.getsize(OUT), sum(len(x) for x in (seqs, tbl_lines, idx_lines, rls_lines, fn_lines, pol_lines, trg_lines, view_lines, grant_lines, fk_lines))))
print(OUT)
