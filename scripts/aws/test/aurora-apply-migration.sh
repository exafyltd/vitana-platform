#!/usr/bin/env bash
# VTID-05023 part 8: proves scripts/aws/aurora-apply-migration.sh and
# scripts/aws/aurora-pgrst-ddl-watch.sql on a throwaway local Postgres. Never
# touches Supabase, Aurora or AWS: a fake `aws` on PATH
# (aurora-migrations/fake_aws.py) implements the RDS Data API calls against the
# local database.
#
#   1. a good file (own BEGIN/COMMIT, $$ function, ';' in strings) commits every
#      statement in one Data API transaction, never sends BEGIN/COMMIT, and
#      sends NOTIFY pgrst after the commit;
#   2. a file whose 3rd statement fails leaves the database unchanged, rolls
#      back and exits non-zero naming statement 3; a failure at COMMIT too;
#   3. non-transactional statements mixed in are refused without
#      --allow-non-transactional (no AWS call), run one by one with it, and an
#      all-non-transactional file runs without a transaction;
#   4. --dry-run, a psql meta-command, a top-level ROLLBACK, a wrong account and
#      MIGRATION_FREEZE=true make no rds-data call; the Data API "not enabled
#      yet" answer is retried;
#   5. the DDL watch: applied twice (idempotent, one statement per line), a
#      LISTENing session gets NOTIFY pgrst 'reload schema' on CREATE/ALTER/DROP,
#      nothing for a temp table;
#   6. RUN-MIGRATION.yml / MIGRATION-DRIFT-CHECK.yml parse, their run blocks
#      pass bash -n, the target resolves input > MIGRATION_TARGET > supabase
#      and MIGRATION_FREEZE=true fails both.
#
# Uses PG* env vars when PGHOST is set (CI service container); otherwise starts
# a private cluster with initdb/pg_ctl.
# Usage: npm run test:aurora-migrations (also runs test_aurora_sql_split.py)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
APPLY="$ROOT/scripts/aws/aurora-apply-migration.sh"
WATCH="$ROOT/scripts/aws/aurora-pgrst-ddl-watch.sql"
FAKE="$ROOT/scripts/aws/test/aurora-migrations/fake_aws.py"

case "${PGHOST:-local}" in
  *supabase*|*amazonaws*|*rds*) echo "refusing: PGHOST=${PGHOST} is not a throwaway database" >&2; exit 2 ;;
esac

WORK="$(mktemp -d)"
STARTED_LOCAL=0
RUN_AS=()
DB="aurora_apply_$$"
cleanup() {
  if [ "$STARTED_LOCAL" = 1 ]; then
    "${RUN_AS[@]}" "$PGBIN/pg_ctl" -D "$WORK/data" -m immediate stop >/dev/null 2>&1 || true
  else
    dropdb --if-exists "$DB" >/dev/null 2>&1 || true
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT

if [ -z "${PGHOST:-}" ]; then
  PGBIN="${PGBIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)}"
  [ -x "${PGBIN:-}/initdb" ] || { echo "initdb not found (install postgresql or set PGBIN / PGHOST)"; exit 2; }
  if [ "$(id -u)" = "0" ]; then
    chown postgres "$WORK"
    RUN_AS=(sudo -u postgres)
  fi
  PORT="${PGPORT_TEST:-55434}"
  "${RUN_AS[@]}" "$PGBIN/initdb" -D "$WORK/data" -U postgres -A trust >/dev/null
  "${RUN_AS[@]}" "$PGBIN/pg_ctl" -D "$WORK/data" -o "-p $PORT -k $WORK -c listen_addresses=''" -w start >/dev/null
  STARTED_LOCAL=1
  export PGHOST="$WORK" PGPORT="$PORT" PGUSER=postgres
fi
createdb "$DB"
export PGDATABASE="$DB"
q() { psql -X -q -A -t -v ON_ERROR_STOP=1 -c "$1"; }

mkdir -p "$WORK/bin" "$WORK/state" "$WORK/sql"
printf '#!/usr/bin/env bash\nexec python3 %q "$@"\n' "$FAKE" > "$WORK/bin/aws"
chmod +x "$WORK/bin/aws"
export PATH="$WORK/bin:$PATH" FAKE_AWS_STATE="$WORK/state" AWS_REGION=eu-central-1 AURORA_DATAAPI_RETRY_SLEEP=0
unset MIGRATION_FREEZE FAKE_AWS_ACCOUNT FAKE_AWS_NOT_ENABLED

PASS=0
ok() { PASS=$((PASS+1)); echo "ok: $*"; }
die() { echo "FAIL: $*" >&2; [ -f "$WORK/out" ] && sed 's/^/  | /' "$WORK/out" >&2; exit 1; }
reset_calls() { : > "$WORK/state/calls.jsonl"; rm -f "$WORK/state/not-enabled-count"; }
calls() { jq -r "$1" "$WORK/state/calls.jsonl"; }
run_apply() { reset_calls; set +e; bash "$APPLY" "$@" >"$WORK/out" 2>&1; RC=$?; set -e; }

# ---- fixtures ------------------------------------------------------------------
cat > "$WORK/sql/good.sql" <<'SQL'
-- a migration the way they are written in supabase/migrations
BEGIN;
CREATE TABLE public.mig_good (id int PRIMARY KEY, note text);
INSERT INTO public.mig_good VALUES (1, 'semi;colon ''quoted'''), (2, E'it\'s; fine');
CREATE OR REPLACE FUNCTION public.mig_good_count() RETURNS int LANGUAGE plpgsql AS $fn$
BEGIN
  RETURN (SELECT count(*) FROM public.mig_good); -- ; inside a body
END;
$fn$;
/* block ; comment */ COMMENT ON TABLE public.mig_good IS 'part 8; test';
COMMIT;
SQL
cat > "$WORK/sql/bad3.sql" <<'SQL'
CREATE TABLE public.mig_bad (id int);
INSERT INTO public.mig_bad VALUES (1);
INSERT INTO public.mig_missing VALUES (1);
CREATE TABLE public.mig_bad_after (id int);
SQL
cat > "$WORK/sql/badcommit.sql" <<'SQL'
CREATE TABLE public.mig_parent (id int PRIMARY KEY);
CREATE TABLE public.mig_child (pid int REFERENCES public.mig_parent DEFERRABLE INITIALLY DEFERRED);
INSERT INTO public.mig_child VALUES (42);
SQL
cat > "$WORK/sql/mixed.sql" <<'SQL'
CREATE TABLE public.mig_idx (a int);
CREATE INDEX CONCURRENTLY mig_idx_a ON public.mig_idx (a);
SQL
cat > "$WORK/sql/allnontx.sql" <<'SQL'
CREATE INDEX CONCURRENTLY IF NOT EXISTS mig_good_note ON public.mig_good (note);
VACUUM public.mig_good;
SQL
printf 'SELECT 1;\n\\set ON_ERROR_STOP on\nCREATE TABLE public.mig_meta (a int);\n' > "$WORK/sql/meta.sql"
printf 'BEGIN;\nCREATE TABLE public.mig_rb (a int);\nROLLBACK;\n' > "$WORK/sql/rollback.sql"
printf 'CREATE TABLE public.mig_retry (a int);\n' > "$WORK/sql/retry.sql"

# ---- 1. good file -------------------------------------------------------------
run_apply --file "$WORK/sql/good.sql"
[ "$RC" = 0 ] || die "good file exited $RC"
[ "$(q 'SELECT public.mig_good_count()')" = 2 ] || die "good file: rows/function missing"
[ "$(q "SELECT note FROM public.mig_good WHERE id = 2")" = "it's; fine" ] || die "good file: E'' string mangled"
[ "$(q "SELECT obj_description('public.mig_good'::regclass)")" = "part 8; test" ] || die "good file: comment missing"
ops=$(calls 'select(.service=="rds-data") | .op' | tr '\n' ' ')
[ "$ops" = "begin-transaction execute-statement execute-statement execute-statement execute-statement commit-transaction execute-statement " ] \
  || die "good file: unexpected Data API sequence: $ops"
[ "$(calls 'select(.op=="execute-statement") | select(.sql | test("^\\s*(BEGIN|COMMIT)\\s*$"; "i")) | .op' | wc -l)" = 0 ] \
  || die "good file: BEGIN/COMMIT were sent as statements"
last=$(jq -s -r '[.[] | select(.op=="execute-statement")] | last | "\(.tx)|\(.sql)"' "$WORK/state/calls.jsonl")
[ "$last" = "null|NOTIFY pgrst, 'reload schema'" ] || die "good file: NOTIFY not sent after commit (got $last)"
ok "good file: 4 statements committed in one transaction, BEGIN/COMMIT dropped, NOTIFY pgrst after commit"

# ---- 2. failure at statement 3 / at commit --------------------------------------
run_apply --file "$WORK/sql/bad3.sql"
[ "$RC" != 0 ] || die "bad file exited 0"
grep -q "FAILED at statement 3 of 4 (line 3" "$WORK/out" || die "bad file: failing statement not named"
grep -q "INSERT INTO public.mig_missing" "$WORK/out" || die "bad file: statement text not printed"
[ "$(q "SELECT count(*) FROM pg_class WHERE relname IN ('mig_bad', 'mig_bad_after')")" = 0 ] || die "bad file: database changed"
[ "$(calls 'select(.op=="rollback-transaction") | .op' | wc -l)" = 1 ] || die "bad file: no rollback-transaction"
[ "$(calls 'select(.op=="commit-transaction" or (.sql // "" | startswith("NOTIFY"))) | .op' | wc -l)" = 0 ] \
  || die "bad file: commit or NOTIFY after a failure"
ok "statement 3 fails: exit $RC, statement named, rolled back, database unchanged, no NOTIFY"

run_apply --file "$WORK/sql/badcommit.sql"
[ "$RC" != 0 ] || die "deferred FK violation at COMMIT exited 0"
grep -q "commit-transaction failed" "$WORK/out" || die "commit failure not reported"
[ "$(q "SELECT count(*) FROM pg_class WHERE relname IN ('mig_parent', 'mig_child')")" = 0 ] || die "commit failure: database changed"
ok "failure at COMMIT: exit $RC, nothing applied"

# ---- 3. non-transactional statements --------------------------------------------
run_apply --file "$WORK/sql/mixed.sql"
[ "$RC" != 0 ] || die "mixed file accepted without --allow-non-transactional"
grep -q "non-transactional" "$WORK/out" || die "mixed file: refusal message missing"
[ -s "$WORK/state/calls.jsonl" ] && die "mixed file: AWS was called before refusing"
ok "mixed transactional/non-transactional file refused without the flag, no AWS call"

run_apply --file "$WORK/sql/mixed.sql" --allow-non-transactional
[ "$RC" = 0 ] || die "mixed file with --allow-non-transactional exited $RC"
grep -q "NO transaction" "$WORK/out" || die "mixed file: no-transaction mode not announced"
[ "$(calls 'select(.op=="begin-transaction") | .op' | wc -l)" = 0 ] || die "mixed file: a transaction was opened"
[ "$(q "SELECT count(*) FROM pg_indexes WHERE indexname = 'mig_idx_a'")" = 1 ] || die "mixed file: index missing"
ok "--allow-non-transactional: statements run one by one without a transaction"

run_apply --file "$WORK/sql/allnontx.sql"
[ "$RC" = 0 ] || die "all-non-transactional file exited $RC"
[ "$(q "SELECT count(*) FROM pg_indexes WHERE indexname = 'mig_good_note'")" = 1 ] || die "all-non-transactional: index missing"
ok "all-non-transactional file runs without a transaction and without the flag"

# ---- 4. no rds-data call -----------------------------------------------------------
run_apply --file "$WORK/sql/good.sql" --dry-run
[ "$RC" = 0 ] && grep -q "Dry run: no AWS call made" "$WORK/out" && grep -q "4 statement(s)" "$WORK/out" || die "dry run"
[ -s "$WORK/state/calls.jsonl" ] && die "dry run called aws"
ok "--dry-run prints the plan and calls nothing"

run_apply --file "$WORK/sql/meta.sql"
[ "$RC" != 0 ] && grep -q "meta.sql:2:" "$WORK/out" || die "meta-command not refused with its line"
[ -s "$WORK/state/calls.jsonl" ] && die "meta-command file called aws"
run_apply --file "$WORK/sql/rollback.sql"
[ "$RC" != 0 ] && grep -q "ROLLBACK" "$WORK/out" || die "top-level ROLLBACK not refused"
[ -s "$WORK/state/calls.jsonl" ] && die "rollback file called aws"
ok "psql meta-command and top-level ROLLBACK refused before any AWS call"

export FAKE_AWS_ACCOUNT=111111111111; run_apply --file "$WORK/sql/retry.sql"; unset FAKE_AWS_ACCOUNT
[ "$RC" != 0 ] && grep -q "expected 472838866351" "$WORK/out" || die "account guard"
[ "$(calls 'select(.service=="rds-data") | .op' | wc -l)" = 0 ] || die "account guard: rds-data called"
export MIGRATION_FREEZE=true; run_apply --file "$WORK/sql/retry.sql"; unset MIGRATION_FREEZE
[ "$RC" != 0 ] && grep -q "schema freeze" "$WORK/out" || die "MIGRATION_FREEZE not enforced"
[ -s "$WORK/state/calls.jsonl" ] && die "freeze: aws called"
ok "wrong account and MIGRATION_FREEZE=true stop before any rds-data call"

export FAKE_AWS_NOT_ENABLED=2; run_apply --file "$WORK/sql/retry.sql"; unset FAKE_AWS_NOT_ENABLED
[ "$RC" = 0 ] && [ "$(grep -c 'Data API not ready yet' "$WORK/out")" = 2 ] || die "HttpEndpointNotEnabled retry"
[ "$(q "SELECT count(*) FROM pg_class WHERE relname = 'mig_retry'")" = 1 ] || die "retry: table missing"
ok "Data API 'not enabled yet' is retried"

# ---- 5. DDL watch ------------------------------------------------------------------
grep -v '^--' "$WATCH" | grep -v '^[[:space:]]*$' | while IFS= read -r stmt; do
  case "$stmt" in *';') ;; *) echo "FAIL: statement does not end on its line: ${stmt:0:120}" >&2; exit 1 ;; esac
done
# exactly what aurora-run-sql.sh does: each non-comment line is one call
for pass in 1 2; do
  grep -v '^--' "$WATCH" | grep -v '^[[:space:]]*$' | while IFS= read -r stmt; do
    psql -X -q -v ON_ERROR_STOP=1 -c "$stmt" >/dev/null 2>&1 || { echo "FAIL: ddl watch pass $pass: $stmt" >&2; exit 1; }
  done
done
[ "$(q "SELECT string_agg(evtname || ':' || evtevent || ':' || evtenabled::text, ',' ORDER BY evtname) FROM pg_event_trigger")" \
  = "pgrst_drop_watch:sql_drop:O,pgrst_watch:ddl_command_end:O" ] || die "ddl watch: event triggers not as expected"
notifies() { psql -X -v ON_ERROR_STOP=1 2>&1 <<SQL | grep -c 'Asynchronous notification "pgrst" with payload "reload schema"' || true
LISTEN pgrst;
$1
SELECT 1;
SQL
}
[ "$(notifies 'CREATE TABLE public.watch_me (a int);')" = 1 ] || die "ddl watch: no NOTIFY on CREATE TABLE"
[ "$(notifies 'ALTER TABLE public.watch_me ADD COLUMN b int;')" = 1 ] || die "ddl watch: no NOTIFY on ALTER TABLE"
[ "$(notifies 'DROP TABLE public.watch_me;')" = 1 ] || die "ddl watch: no NOTIFY on DROP TABLE"
[ "$(notifies 'CREATE TEMP TABLE scratch (a int);')" = 0 ] || die "ddl watch: NOTIFY for a temp table"
ok "DDL watch applied twice line by line; NOTIFY pgrst on CREATE/ALTER/DROP, none for a temp table"

# ---- 6. workflows: parse, bash -n, target resolution and freeze -------------------
python3 - "$ROOT" "$WORK" <<'PY'
import os, re, subprocess, sys, yaml
root, work = sys.argv[1], sys.argv[2]
for wf in ("RUN-MIGRATION.yml", "MIGRATION-DRIFT-CHECK.yml"):
    d = yaml.safe_load(open(os.path.join(root, ".github/workflows", wf)))
    resolve = None
    for job in d["jobs"].values():
        for st in job["steps"]:
            if "run" not in st:
                continue
            body = re.sub(r"\$\{\{[^}]*\}\}", "X", st["run"])
            r = subprocess.run(["bash", "-n"], input=body, text=True, capture_output=True)
            assert r.returncode == 0, f"{wf} {st.get('name')}: {r.stderr}"
            if st.get("id") == "target":
                resolve = st["run"]
    assert resolve, f"{wf}: no resolve step"
    inputs = (d.get(True) or d.get("on"))["workflow_dispatch"]["inputs"]
    assert inputs["target"]["options"] == ["default", "supabase", "aurora"], wf
    cases = [  # (input, var, freeze) -> target or None (fails)
        ("default", "", "", "supabase"), ("", "", "", "supabase"), ("default", "aurora", "", "aurora"),
        ("supabase", "aurora", "", "supabase"), ("aurora", "", "", "aurora"), ("default", "bogus", "", None),
        ("default", "aurora", "true", None), ("supabase", "", "true", None), ("default", "", "false", "supabase"),
    ]
    for inp, var, freeze, want in cases:
        out = os.path.join(work, "gh_output")
        open(out, "w").close()
        env = dict(os.environ, TARGET_INPUT=inp, TARGET_VAR=var, MIGRATION_FREEZE=freeze, GITHUB_OUTPUT=out)
        r = subprocess.run(["bash", "-c", resolve], env=env, capture_output=True, text=True)
        got = open(out).read().strip().removeprefix("target=") if r.returncode == 0 else None
        assert got == want, f"{wf}: input={inp!r} var={var!r} freeze={freeze!r}: got {got!r}, want {want!r} {r.stdout}"
        if freeze == "true":
            assert "MIGRATION_FREEZE" in r.stdout, r.stdout
PY
ok "workflows parse, run blocks pass bash -n, target = input > MIGRATION_TARGET > supabase, MIGRATION_FREEZE=true fails both"

echo "== splitter unit tests, migration sweep, psql equivalence"
( cd "$ROOT/scripts/aws/test" && REQUIRE_PG=1 python3 -m unittest test_aurora_sql_split )
ok "test_aurora_sql_split.py"

echo "PASS vtid-05023 aurora migrations ($PASS checks)"
