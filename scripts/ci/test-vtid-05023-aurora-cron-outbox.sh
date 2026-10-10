#!/usr/bin/env bash
# VTID-05023 part 6 — local proof for the Aurora cron + outbox files. Never touches a
# live database or AWS: everything runs on a throwaway local Postgres (initdb/pg_ctl)
# and a fake `aws` on PATH.
#
#   1. scripts/aws/aurora-cutover-outbox.sql applies line by line (exactly how
#      aurora-run-sql.sh feeds it), twice (idempotent); the two trigger functions queue
#      the right rows (URL, headers with secret REFERENCES only, body); RLS/grants keep
#      anon and authenticated out; the claim/complete/fail RPCs behave (SKIP LOCKED,
#      lease, backoff, max attempts, attempt-scoped idempotency).
#   2. scripts/aws/aurora-cutover-cron.sql applies line by line, twice, and leaves the
#      expected 21 jobs with byte-exact commands. Without pg_cron installed locally the
#      `cron` schema is a stub with pg_cron's schedule/unschedule/alter_job semantics and
#      CREATE EXTENSION is skipped (reported). WITH_PG_CRON=1 runs the same file, including
#      CREATE EXTENSION, against real pg_cron in a postgres:16 container (PG_CRON_IMAGE to
#      use a registry mirror, e.g. mirror.gcr.io/library/postgres:16).
#   3. scripts/aws/supabase-cutover-unschedule.sql + -rollback.sql against the stub:
#      25 jobs off and both triggers disabled, then all 25 back byte-identical.
#   4. scripts/aws/aurora-cluster-params-cutover.sh against a fake aws: dry run changes
#      nothing; --apply keeps existing shared_preload_libraries, copies a default group,
#      creates both alarms and never reboots.
#   5. The workflow AWS-PROD-SETUP-SCHEDULED-EDGE-CALLS.yml parses and its bash is valid.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUTBOX="$ROOT/scripts/aws/aurora-cutover-outbox.sql"
CRON="$ROOT/scripts/aws/aurora-cutover-cron.sql"
UNSCHED="$ROOT/scripts/aws/supabase-cutover-unschedule.sql"
ROLLBACK="$ROOT/scripts/aws/supabase-cutover-unschedule-rollback.sql"
PARAMS="$ROOT/scripts/aws/aurora-cluster-params-cutover.sh"

PGBIN="${PGBIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)}"
[ -x "$PGBIN/initdb" ] || { echo "initdb not found (set PGBIN)"; exit 2; }

WORK="$(mktemp -d)"
chmod 755 "$WORK"
RUN_AS=()
if [ "$(id -u)" = "0" ]; then chown postgres "$WORK"; RUN_AS=(sudo -u postgres); fi
PORT="${PGPORT_TEST:-55441}"
CONTAINER=""
cleanup() {
  "${RUN_AS[@]}" "$PGBIN/pg_ctl" -D "$WORK/data" -m immediate stop >/dev/null 2>&1 || true
  [ -n "$CONTAINER" ] && docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

"${RUN_AS[@]}" "$PGBIN/initdb" -D "$WORK/data" -U postgres >/dev/null
"${RUN_AS[@]}" "$PGBIN/pg_ctl" -D "$WORK/data" -o "-p $PORT -k $WORK -c listen_addresses=''" -w start >/dev/null
PSQL=("${RUN_AS[@]}" psql -X -q -v ON_ERROR_STOP=1 -h "$WORK" -p "$PORT" -U postgres -d postgres)

fail() { echo "FAIL: $*"; exit 1; }
q() { "${PSQL[@]}" -tA -c "$1"; }
pass=0
ok() { pass=$((pass+1)); echo "ok $pass - $*"; }

# Feed a file one line per statement, skipping blank/-- lines (aurora-run-sql.sh semantics).
# $2: optional regex of lines to skip (reported).
apply_lines() {
  local file="$1" skip="${2:-}" n=0 line
  while IFS= read -r line; do
    [[ -z "$line" || "$line" == --* ]] && continue
    if [ -n "$skip" ] && [[ "$line" =~ $skip ]]; then echo "  (skipped: $line)"; continue; fi
    n=$((n+1))
    "${PSQL[@]}" -c "$line" >/dev/null || fail "statement $n of $(basename "$file"): ${line:0:160}"
  done < "$file"
  echo "  applied $n statements from $(basename "$file")"
}

# ── Fixture: roles + the two tables and their Aurora triggers ───────────
"${PSQL[@]}" <<'SQL'
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;
CREATE TYPE public.test_user_application_status AS ENUM ('pending', 'active', 'rejected');
CREATE TABLE public.test_user_applications (id uuid PRIMARY KEY, status public.test_user_application_status NOT NULL DEFAULT 'pending', confirmation_sent_at timestamptz);
CREATE TABLE public.user_discount_codes (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, code text NOT NULL UNIQUE, discount_percent integer NOT NULL DEFAULT 10, valid_for text NOT NULL DEFAULT 'events', tenant_slug text NOT NULL DEFAULT 'maxina', expires_at timestamptz NOT NULL DEFAULT (now() + interval '90 days'));
-- placeholder bodies, replaced by the outbox file (as on Aurora, where the triggers exist already)
CREATE FUNCTION public.notify_test_user_confirmation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;
CREATE FUNCTION public.notify_welcome_discount() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;
-- triggers exactly as services/postgrest-aurora-proxy/aurora-restore-04-triggers.sql
CREATE TRIGGER trg_send_test_user_confirmation AFTER UPDATE OF status ON public.test_user_applications FOR EACH ROW WHEN (((new.status = ANY (ARRAY['active'::test_user_application_status, 'rejected'::test_user_application_status])) AND (old.status IS DISTINCT FROM new.status) AND (new.confirmation_sent_at IS NULL))) EXECUTE FUNCTION notify_test_user_confirmation();
CREATE TRIGGER on_discount_code_created_send_email AFTER INSERT ON public.user_discount_codes FOR EACH ROW EXECUTE FUNCTION notify_welcome_discount();
SQL

echo "== 1. outbox"
apply_lines "$OUTBOX"
apply_lines "$OUTBOX"
ok "outbox file applies line by line, twice"

A=aaaaaaaa-0000-0000-0000-000000000001
U=bbbbbbbb-0000-0000-0000-000000000002
D=cccccccc-0000-0000-0000-000000000003
"${PSQL[@]}" -c "INSERT INTO test_user_applications (id) VALUES ('$A')"
"${PSQL[@]}" -c "UPDATE test_user_applications SET status = 'active' WHERE id = '$A'"
"${PSQL[@]}" -c "INSERT INTO user_discount_codes (id, user_id, code, discount_percent, expires_at) VALUES ('$D', '$U', 'MAXINA-ABC123', 10, '2027-01-01 00:00:00+00')"
[ "$(q 'select count(*) from outbound_http_requests')" = "2" ] || fail "expected 2 outbox rows"

GOT=$(q "select url||'|'||method||'|'||headers::text||'|'||body::text||'|'||status||'|'||attempts||'|'||source from outbound_http_requests where source='notify_test_user_confirmation'")
EXP="https://inmkhvwdcuyhnxkgfvsb.supabase.co/functions/v1/send-test-user-confirmation|POST|{\"Content-Type\": \"application/json\", \"X-Trigger-Secret\": {\"secret_ref\": \"email_trigger_secret\"}}|{\"application_id\": \"$A\"}|pending|0|notify_test_user_confirmation"
[ "$GOT" = "$EXP" ] || fail "test-user row: got [$GOT] expected [$EXP]"
ok "notify_test_user_confirmation queues the Supabase URL/headers/body, secret as a reference"

GOT=$(q "select url||'|'||headers::text||'|'||body::text from outbound_http_requests where source='notify_welcome_discount'")
EXP="https://inmkhvwdcuyhnxkgfvsb.supabase.co/functions/v1/send-welcome-discount|{\"Content-Type\": \"application/json\", \"Authorization\": {\"secret_ref\": \"supabase_service_role_bearer\"}}|{\"code\": \"MAXINA-ABC123\", \"user_id\": \"$U\", \"expires_at\": \"2027-01-01T00:00:00+00:00\", \"discount_code_id\": \"$D\", \"discount_percent\": 10}"
[ "$GOT" = "$EXP" ] || fail "discount row: got [$GOT] expected [$EXP]"
ok "notify_welcome_discount queues the Supabase path/headers/body, secret as a reference"

"${PSQL[@]}" -c "UPDATE test_user_applications SET status = 'active' WHERE id = '$A'"
"${PSQL[@]}" -c "UPDATE test_user_applications SET status = 'rejected', confirmation_sent_at = now() WHERE id = '$A'"
[ "$(q 'select count(*) from outbound_http_requests')" = "2" ] || fail "trigger WHEN clause must not queue unchanged/confirmed rows"
ok "trigger WHEN clause unchanged (no row for same status or already confirmed)"

[ "$(q "select count(*) from outbound_http_requests where headers::text ~ '(Bearer|eyJ)'")" = "0" ] || fail "a secret-looking value is stored in headers"
ok "no secret value stored in any row"

# discount trigger never blocks the insert, even when queueing fails
"${PSQL[@]}" -c "ALTER TABLE outbound_http_requests RENAME TO outbound_http_requests_tmp"
"${PSQL[@]}" -c "INSERT INTO user_discount_codes (user_id, code) VALUES ('$U', 'MAXINA-ZZZ999')" 2>/dev/null || fail "discount insert must not fail when the outbox insert fails"
"${PSQL[@]}" -c "ALTER TABLE outbound_http_requests_tmp RENAME TO outbound_http_requests"
ok "a failing outbox insert never blocks new-member provisioning (user_discount_codes)"

for r in anon authenticated; do
  if "${PSQL[@]}" -c "SET ROLE $r; SELECT * FROM outbound_http_requests" >/dev/null 2>&1; then fail "$r can read the outbox"; fi
  if "${PSQL[@]}" -c "SET ROLE $r; SELECT * FROM outbound_http_claim()" >/dev/null 2>&1; then fail "$r can claim"; fi
done
[ "$(q "select relrowsecurity from pg_class where relname='outbound_http_requests'")" = "t" ] || fail "RLS off"
[ "$(q "select count(*) from pg_policies where tablename='outbound_http_requests'")" = "0" ] || fail "policies exist"
q "SET ROLE service_role; SELECT count(*) FROM outbound_http_claim(0)" >/dev/null || fail "service_role cannot execute the claim RPC"
"${PSQL[@]}" -c "UPDATE outbound_http_requests SET status='pending', attempts=0, locked_until=NULL"
ok "RLS on, no policies; anon/authenticated locked out; service_role may execute the RPCs"

# RPC semantics
T=$(q "select id from outbound_http_requests where source='notify_test_user_confirmation'")
W=$(q "select id from outbound_http_requests where source='notify_welcome_discount'")
[ "$(q "select string_agg(id||':'||status||':'||attempts, ',' order by id) from outbound_http_claim(10)")" = "$T:sending:1,$W:sending:1" ] || fail "claim"
[ "$(q "select count(*) from outbound_http_claim(10)")" = "0" ] || fail "held rows must not be claimed again"
[ "$(q "select outbound_http_complete($T, 1)")" = "t" ] || fail "complete"
[ "$(q "select outbound_http_complete($T, 1)")" = "f" ] || fail "second complete must be a no-op"
[ "$(q "select status||':'||(sent_at is not null) from outbound_http_requests where id=$T")" = "sent:true" ] || fail "sent state"
[ "$(q "select outbound_http_complete($W, 7)")" = "f" ] || fail "complete with a wrong attempt must not apply"
[ "$(q "select outbound_http_fail($W, 1, 'HTTP 500', 30)")" = "pending" ] || fail "fail→pending"
[ "$(q "select (next_attempt_at > now() + interval '25 seconds')::text||':'||last_error from outbound_http_requests where id=$W")" = "true:HTTP 500" ] || fail "backoff not recorded"
[ "$(q "select count(*) from outbound_http_claim(10)")" = "0" ] || fail "a row in backoff must not be claimed"
"${PSQL[@]}" -c "UPDATE outbound_http_requests SET next_attempt_at = now() - interval '1 second' WHERE id=$W"
[ "$(q "select attempts from outbound_http_claim(10)")" = "2" ] || fail "re-claim after backoff"
ok "claim / complete / fail: attempt-scoped, idempotent, backoff respected"

"${PSQL[@]}" -c "UPDATE outbound_http_requests SET locked_until = now() - interval '1 second' WHERE id=$W"
[ "$(q "select attempts from outbound_http_claim(10)")" = "3" ] || fail "an expired lease must be re-claimable"
[ "$(q "select outbound_http_fail($W, 2, 'late', 30)")" = "" ] || fail "a stale attempt must not record a failure"
"${PSQL[@]}" -c "UPDATE outbound_http_requests SET attempts = 5, locked_until = now() - interval '1 second' WHERE id=$W"
[ "$(q "select count(*) from outbound_http_claim(10)")" = "0" ] || fail "no re-claim after the final attempt"
[ "$(q "select status from outbound_http_requests where id=$W")" = "failed" ] || fail "lease expired after the final attempt must end failed"
"${PSQL[@]}" -c "UPDATE outbound_http_requests SET status='sending', attempts=4, locked_until=now()+interval '1 minute' WHERE id=$W"
[ "$(q "select outbound_http_fail($W, 4, 'HTTP 503', NULL)")" = "failed" ] || fail "final fail"
ok "lease expiry re-claims; stale attempts ignored; max attempts ends in failed"

"${PSQL[@]}" -c "INSERT INTO outbound_http_requests (url, body) VALUES ('https://inmkhvwdcuyhnxkgfvsb.supabase.co/functions/v1/x', '{}')"
L=$(q "select max(id) from outbound_http_requests")
( "${PSQL[@]}" -c "BEGIN; SELECT 1 FROM outbound_http_requests WHERE id=$L FOR UPDATE; SELECT pg_sleep(3); COMMIT;" >/dev/null ) &
LOCKER=$!
sleep 1
[ "$(q "select count(*) from outbound_http_claim(10)")" = "0" ] || fail "a row locked by another session must be skipped (SKIP LOCKED)"
wait "$LOCKER"
[ "$(q "select count(*) from outbound_http_claim(10)")" = "1" ] || fail "the row is claimable once the lock is gone"
ok "FOR UPDATE SKIP LOCKED: a concurrently locked row is skipped, not waited on"

echo "== 2. aurora-cutover-cron.sql"
HAVE_CRON=$(q "select count(*) from pg_available_extensions where name='pg_cron'")
"${PSQL[@]}" <<'SQL'
-- Stub of pg_cron's surface used by the cutover files (schedule upserts by name, as pg_cron >= 1.3).
CREATE SCHEMA cron;
CREATE TABLE cron.job (jobid bigserial PRIMARY KEY, schedule text NOT NULL, command text NOT NULL, nodename text DEFAULT 'localhost', nodeport int DEFAULT 5432, database text DEFAULT current_database(), username text DEFAULT current_user, active boolean DEFAULT true, jobname text UNIQUE);
CREATE FUNCTION cron.schedule(job_name text, schedule text, command text) RETURNS bigint LANGUAGE plpgsql AS $$ DECLARE v bigint; BEGIN IF schedule !~ '^(\S+\s+){4}\S+$' THEN RAISE EXCEPTION 'invalid schedule: %', schedule; END IF; INSERT INTO cron.job (jobname, schedule, command) VALUES (job_name, schedule, command) ON CONFLICT (jobname) DO UPDATE SET schedule = EXCLUDED.schedule, command = EXCLUDED.command RETURNING jobid INTO v; RETURN v; END $$;
CREATE FUNCTION cron.unschedule(job_id bigint) RETURNS boolean LANGUAGE plpgsql AS $$ BEGIN DELETE FROM cron.job WHERE jobid = job_id; IF NOT FOUND THEN RAISE EXCEPTION 'could not find valid entry for job %', job_id; END IF; RETURN true; END $$;
CREATE FUNCTION cron.alter_job(job_id bigint, schedule text DEFAULT NULL, command text DEFAULT NULL, database text DEFAULT NULL, username text DEFAULT NULL, active boolean DEFAULT NULL) RETURNS void LANGUAGE sql AS $$ UPDATE cron.job SET schedule = coalesce(alter_job.schedule, job.schedule), command = coalesce(alter_job.command, job.command), active = coalesce(alter_job.active, job.active) WHERE jobid = job_id $$;
SQL
echo "  pg_cron available locally: $([ "$HAVE_CRON" = "1" ] && echo yes || echo 'no — stub cron schema, CREATE EXTENSION line skipped')"
apply_lines "$CRON" '^CREATE EXTENSION'
apply_lines "$CRON" '^CREATE EXTENSION'
EXPECTED_JOBS="billing_feature_usage_prune,billing_lifecycle_notifications,billing_reconcile_grants,community-search-history-retention,compute_user_reputation_daily,conversation-metrics-hourly,dev-autopilot-auto-archive,feedback-auto-triage,feedback-classifier,intent-matches-archival,intent_matches_recompute_daily,intent_supply_seeder_daily,oasis-events-info-retention,purge-memory-transcript-turns,reap_stale_live_streams,tenant-kpi-daily-retention,vitana-id-mirror-reconcile,voice-healing-dedupe-prune,voice-healing-history-prune,voice-healing-shadow-log-prune,voice-healing-spec-memory-prune"
[ "$(q "select string_agg(jobname, ',' order by jobname) from cron.job")" = "$EXPECTED_JOBS" ] || fail "cron job names"
ok "21 plain-SQL jobs scheduled (jobs 15/16 are TODO: commands not in git), idempotent on re-run"

SCHED=$(q "select string_agg(jobname||'='||schedule, ';' order by jobname) from cron.job")
EXP_SCHED="billing_feature_usage_prune=0 3 * * *;billing_lifecycle_notifications=15 * * * *;billing_reconcile_grants=10 3 * * *;community-search-history-retention=15 4 * * *;compute_user_reputation_daily=0 4 * * *;conversation-metrics-hourly=7 * * * *;dev-autopilot-auto-archive=23 3 * * *;feedback-auto-triage=*/5 * * * *;feedback-classifier=*/5 * * * *;intent-matches-archival=30 4 * * *;intent_matches_recompute_daily=15 5 * * *;intent_supply_seeder_daily=45 4 * * *;oasis-events-info-retention=0 3 * * *;purge-memory-transcript-turns=17 3 * * *;reap_stale_live_streams=15 * * * *;tenant-kpi-daily-retention=17 3 * * *;vitana-id-mirror-reconcile=0 4 * * *;voice-healing-dedupe-prune=15 3 * * *;voice-healing-history-prune=25 3 * * *;voice-healing-shadow-log-prune=30 3 * * *;voice-healing-spec-memory-prune=20 3 * * *"
[ "$SCHED" = "$EXP_SCHED" ] || fail "schedules differ from side-effects.md section A: $SCHED"
ok "schedules match side-effects.md section A"

# Byte-exact commands, checked against the migration text for the two multi-line ones.
C32=$(q "select command from cron.job where jobname='conversation-metrics-hourly'")
M32=$(python3 - "$ROOT/supabase/migrations/20260923140000_vtid_04371_conversation_metrics_hourly.sql" <<'PY'
import re, sys
s = open(sys.argv[1]).read()
print(re.search(r"'conversation-metrics-hourly',\s*'7 \* \* \* \*',\s*\$cron\$(.*?)\$cron\$", s, re.S).group(1))
PY
)
[ "$C32" = "$M32" ] || fail "job 32 command differs from its migration"
C7=$(q "select md5(command) from cron.job where jobname='dev-autopilot-auto-archive'")
M7=$(python3 - "$ROOT/supabase/migrations/20260416100000_dev_autopilot.sql" <<'PY'
import hashlib, re, sys
s = open(sys.argv[1]).read()
print(hashlib.md5(re.search(r"'dev-autopilot-auto-archive',\s*'23 3 \* \* \*',[^\n]*\n\s*\$cron\$(.*?)\$cron\$", s, re.S).group(1).encode()).hexdigest())
PY
)
[ "$C7" = "$M7" ] || fail "job 7 command differs from its migration"
[ "$(q "select command from cron.job where jobname='oasis-events-info-retention'")" = "CALL public.oasis_events_cleanup_batched(14, 5000, 200)" ] || fail "job 6 command"
[ "$(q "select command from cron.job where jobname='community-search-history-retention'")" = "DELETE FROM public.community_search_history WHERE created_at < now() - interval '30 days'" ] || fail "job 22 command"
ok "multi-line commands (jobs 7, 32) byte-identical to their migrations; quoting of 6, 22 exact"

if [ "${WITH_PG_CRON:-0}" = "1" ]; then
  echo "  WITH_PG_CRON=1: applying the full file (incl. CREATE EXTENSION) to real pg_cron in postgres:16"
  CONTAINER="vtid05023-pgcron-$$"
  docker run -d --name "$CONTAINER" -e POSTGRES_PASSWORD=x -e POSTGRES_DB=vitana "${PG_CRON_IMAGE:-postgres:16}" >/dev/null
  for i in $(seq 1 60); do docker exec "$CONTAINER" pg_isready -U postgres >/dev/null 2>&1 && break; sleep 1; done
  docker exec -e DEBIAN_FRONTEND=noninteractive "$CONTAINER" bash -c 'apt-get update -qq >/dev/null && apt-get install -y -qq postgresql-16-cron >/dev/null 2>&1' \
    || fail "could not install postgresql-16-cron in the container"
  docker exec "$CONTAINER" bash -c "echo \"shared_preload_libraries = 'pg_cron'\" >> /var/lib/postgresql/data/postgresql.conf; echo \"cron.database_name = 'vitana'\" >> /var/lib/postgresql/data/postgresql.conf"
  docker restart "$CONTAINER" >/dev/null
  for i in $(seq 1 60); do docker exec "$CONTAINER" pg_isready -U postgres -d vitana >/dev/null 2>&1 && break; sleep 1; done
  sleep 2
  for pass_no in 1 2; do
    while IFS= read -r line; do
      [[ -z "$line" || "$line" == --* ]] && continue
      docker exec "$CONTAINER" psql -X -q -v ON_ERROR_STOP=1 -U postgres -d vitana -c "$line" >/dev/null || fail "real pg_cron: ${line:0:160}"
    done < "$CRON"
  done
  N=$(docker exec "$CONTAINER" psql -X -tA -U postgres -d vitana -c "select count(*) from cron.job")
  [ "$N" = "21" ] || fail "real pg_cron: expected 21 jobs, got $N"
  ok "real pg_cron: CREATE EXTENSION + 21 jobs, applied twice"

  # The Supabase window files against real pg_cron (alter_job named args, unschedule by id).
  dq() { docker exec "$CONTAINER" psql -X -q -tA -v ON_ERROR_STOP=1 -U postgres -d vitana -c "$1"; }
  dfile() { local line; while IFS= read -r line; do [[ -z "$line" || "$line" == --* ]] && continue; dq "$line" >/dev/null || fail "real pg_cron: ${line:0:160}"; done < "$1"; }
  dq "CREATE TABLE public.test_user_applications (id uuid, status text); CREATE TABLE public.user_discount_codes (id uuid);
      CREATE FUNCTION public.noop() RETURNS trigger LANGUAGE plpgsql AS \$\$ BEGIN RETURN NEW; END \$\$;
      CREATE TRIGGER trg_send_test_user_confirmation AFTER UPDATE ON public.test_user_applications FOR EACH ROW EXECUTE FUNCTION noop();
      CREATE TRIGGER on_discount_code_created_send_email AFTER INSERT ON public.user_discount_codes FOR EACH ROW EXECUTE FUNCTION noop();
      SELECT cron.schedule('appointment-reminders-hourly', '0 * * * *', E'\n  SELECT 1 AS request_id;\n  ');
      SELECT cron.schedule('run-api-integration-tests', '*/15 * * * *', 'SELECT 4');
      SELECT cron.schedule('vitana_id_mirror_reconcile_daily', '15 3 * * *', 'SELECT 15');
      SELECT cron.schedule('intent_matches_archive_daily', '30 3 * * *', 'SELECT 16');
      SELECT cron.alter_job((SELECT jobid FROM cron.job WHERE jobname = 'feedback-classifier'), active => false);" >/dev/null
  DB=$(dq "select string_agg(jobname||'|'||schedule||'|'||command||'|'||active, E'\n' order by jobname) from cron.job")
  dfile "$UNSCHED"
  [ "$(dq "select count(*) from cron.job")" = "0" ] || fail "real pg_cron: unschedule left jobs"
  dfile "$ROLLBACK"
  [ "$(dq "select string_agg(jobname||'|'||schedule||'|'||command||'|'||active, E'\n' order by jobname) from cron.job")" = "$DB" ] || fail "real pg_cron: rollback not identical"
  ok "real pg_cron: Supabase unschedule removes all 25, rollback restores them identically"
else
  echo "  (real pg_cron not exercised; run with WITH_PG_CRON=1 to apply against pg_cron in docker postgres:16)"
fi

echo "== 3. Supabase unschedule + rollback (stub cron)"
"${PSQL[@]}" -c "DELETE FROM cron.job"
"${PSQL[@]}" -c "INSERT INTO cron.job (jobname, schedule, command) VALUES ('appointment-reminders-hourly', '0 * * * *', E'\n  SELECT net.http_post(url := ''x'') AS request_id;\n  '), ('run-api-integration-tests', '*/15 * * * *', 'SELECT 4'), ('vitana_id_mirror_reconcile_daily', '15 3 * * *', 'SELECT 15'), ('intent_matches_archive_daily', '30 3 * * *', 'SELECT 16'), ('some-other-job', '0 0 * * *', 'SELECT 0')"
apply_lines "$CRON" '^CREATE EXTENSION'
"${PSQL[@]}" -c "UPDATE cron.job SET active = false WHERE jobname = 'feedback-classifier'"
BEFORE=$(q "select string_agg(jobname||'|'||schedule||'|'||command||'|'||active, E'\n' order by jobname) from cron.job where jobname <> 'some-other-job'")
[ "$(q "select count(*) from cron.job")" = "26" ] || fail "fixture should hold 25 + 1 jobs"
apply_lines "$UNSCHED"
[ "$(q "select string_agg(jobname, ',') from cron.job")" = "some-other-job" ] || fail "unschedule must remove exactly the 25 jobs"
[ "$(q "select string_agg(tgname||'='||tgenabled::text, ',' order by tgname) from pg_trigger where tgname in ('trg_send_test_user_confirmation','on_discount_code_created_send_email')")" = "on_discount_code_created_send_email=D,trg_send_test_user_confirmation=D" ] || fail "triggers not disabled"
apply_lines "$UNSCHED"
ok "unschedule: 25 jobs gone (others kept), both pg_net triggers disabled, re-run safe"
apply_lines "$ROLLBACK"
AFTER=$(q "select string_agg(jobname||'|'||schedule||'|'||command||'|'||active, E'\n' order by jobname) from cron.job where jobname <> 'some-other-job'")
[ "$BEFORE" = "$AFTER" ] || fail "rollback did not restore the jobs byte-identically"
[ "$(q "select string_agg(tgenabled::text, '') from pg_trigger where tgname in ('trg_send_test_user_confirmation','on_discount_code_created_send_email')")" = "OO" ] || fail "triggers not re-enabled"
apply_lines "$ROLLBACK"
ok "rollback: all 25 back with identical schedule/command/active, triggers enabled, re-run safe"

echo "== 4. aurora-cluster-params-cutover.sh (fake aws)"
FAKE="$WORK/fakebin"; mkdir -p "$FAKE"
cat > "$FAKE/aws" <<'FAKEAWS'
#!/usr/bin/env bash
echo "$*" >> "$AWS_CALL_LOG"
case "$*" in
  "sts get-caller-identity"*) echo "${FAKE_ACCOUNT:-472838866351}" ;;
  *"describe-db-clusters"*"DBClusterParameterGroup'"*|*"describe-db-clusters"*"DBClusterParameterGroup "*) echo "$FAKE_GROUP" ;;
  *"describe-db-clusters"*"IsClusterWriter"*) echo "vitana-aurora-prod-instance-1" ;;
  *"describe-db-clusters"*"DBClusterMembers[].DBInstanceIdentifier"*) echo "vitana-aurora-prod-instance-1	vitana-aurora-prod-instance-2" ;;
  *"describe-db-clusters"*) echo "$FAKE_GROUP" ;;
  *"describe-db-cluster-parameter-groups"*"--query"*) echo "aurora-postgresql16" ;;
  *"describe-db-cluster-parameter-groups"*"vitana-aurora-prod-cluster-params"*) [ "${FAKE_CUSTOM_EXISTS:-0}" = 1 ] || exit 254 ;;
  *"describe-db-cluster-parameter-groups"*) : ;;
  *"describe-db-cluster-parameters"*) echo "${FAKE_LIBS:-None}" ;;
  *) : ;;
esac
FAKEAWS
chmod +x "$FAKE/aws"
export AWS_CALL_LOG="$WORK/aws.log"

: > "$AWS_CALL_LOG"
OUT=$(PATH="$FAKE:$PATH" FAKE_GROUP=default.aurora-postgresql16 FAKE_LIBS="pg_stat_statements" bash "$PARAMS")
grep -q "shared_preload_libraries: 'pg_stat_statements' -> 'pg_stat_statements,pg_cron'" <<<"$OUT" || fail "libs merge (dry run)"
grep -q "DEFAULT group default.aurora-postgresql16" <<<"$OUT" || fail "default group not called out"
grep -q "aws rds reboot-db-instance --region eu-central-1 --db-instance-identifier vitana-aurora-prod-instance-2" <<<"$OUT" || fail "reboot command not printed"
if grep -Eq "modify-|copy-|put-metric-alarm|reboot" "$AWS_CALL_LOG"; then fail "dry run made a change: $(cat "$AWS_CALL_LOG")"; fi
ok "dry run: prints the plan + reboot commands, makes no change"

: > "$AWS_CALL_LOG"
PATH="$FAKE:$PATH" FAKE_GROUP=default.aurora-postgresql16 FAKE_LIBS="pg_stat_statements" bash "$PARAMS" --apply >/dev/null
grep -q "rds copy-db-cluster-parameter-group .*--source-db-cluster-parameter-group-identifier default.aurora-postgresql16 --target-db-cluster-parameter-group-identifier vitana-aurora-prod-cluster-params" "$AWS_CALL_LOG" || fail "copy of the default group"
grep -q "rds modify-db-cluster-parameter-group .*--db-cluster-parameter-group-name vitana-aurora-prod-cluster-params" "$AWS_CALL_LOG" || fail "modify params"
grep -q "rds modify-db-cluster .*--db-cluster-parameter-group-name vitana-aurora-prod-cluster-params" "$AWS_CALL_LOG" || fail "attach group"
grep -q "OldestReplicationSlotLag" "$AWS_CALL_LOG" && grep -q "TransactionLogsDiskUsage" "$AWS_CALL_LOG" || fail "alarms"
if grep -q "reboot" "$AWS_CALL_LOG"; then fail "--apply must never reboot"; fi
ok "--apply on a default group: copy + set + attach + 2 alarms, no reboot"

: > "$AWS_CALL_LOG"
OUT=$(PATH="$FAKE:$PATH" FAKE_GROUP=vitana-custom FAKE_LIBS="pg_stat_statements,pg_cron" bash "$PARAMS" --apply)
grep -q "'pg_stat_statements,pg_cron' -> 'pg_stat_statements,pg_cron'" <<<"$OUT" || fail "pg_cron must not be added twice"
if grep -Eq "copy-db-cluster-parameter-group|modify-db-cluster " "$AWS_CALL_LOG"; then fail "custom group must be modified in place, not copied/attached"; fi
ok "--apply on a custom group: modified in place, pg_cron not duplicated"

if PATH="$FAKE:$PATH" FAKE_ACCOUNT=111111111111 FAKE_GROUP=x bash "$PARAMS" >/dev/null 2>&1; then fail "account guard"; fi
ok "account guard refuses another account"

echo "== 5. workflow"
python3 "$ROOT/scripts/aws/test/check_workflow_scheduled_edge_calls.py"
ok "AWS-PROD-SETUP-SCHEDULED-EDGE-CALLS.yml"

echo "PASS: $pass checks (VTID-05023 part 6 cron + outbox)"
