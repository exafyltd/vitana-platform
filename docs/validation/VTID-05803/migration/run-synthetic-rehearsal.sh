#!/usr/bin/env bash
# VTID-05803 — reproducible synthetic rehearsal of the approved no-hashes export and the shared restore sequence.
# SYNTHETIC DATA ONLY: fake emails, fake hash strings, a generated test passphrase. It never connects to production:
# the one AWS call the export makes (the production URL secret) is answered by a local shim that returns the synthetic
# source. Requires a local PostgreSQL 16 with TLS (ssl=on) reachable as a superuser. The cluster is not started here.
# Evidence (results, counts, md5 digests, logs without row content or hashes) is written to rehearsal/evidence/<run>/.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
# scripts are beside this runner in the committed layout, or in ../iam-exception in the working layout
IAD="$HERE"; [ -f "$HERE/../iam-exception/02-export-cloudshell-allowlisted.sh" ] && IAD="$HERE/../iam-exception"
PORT=${RPG_PORT:-55432}; SU=${RPG_USER:-postgres}
PSQL=/usr/lib/postgresql/16/bin/psql; PR=/usr/lib/postgresql/16/bin/pg_restore; PD=/usr/lib/postgresql/16/bin/pg_dump
RUN=${REHEARSAL_SCRATCH:-/tmp/claude-0/-home-user/d0f42030-d9d0-5c2d-bddb-4a851acb8ddb/scratchpad/rehearsal-run}
RUN_ID=$(date -u +%Y%m%dT%H%M%SZ); EVID="${EVID_BASE:-$HERE/evidence}/$RUN_ID"; mkdir -p "$EVID"
rm -rf "$RUN"; mkdir -p "$RUN/bin" "$RUN/home"; chmod 700 "$RUN"
export PGSSLMODE=require
SQ() { "$PSQL" -X -At -h 127.0.0.1 -p "$PORT" -U "$SU" -d "$1" -c "$2"; }
RESULTS="$EVID/results.txt"; PASS=0; FAIL=0
ok()  { echo "PASS  $1" | tee -a "$RESULTS"; PASS=$((PASS+1)); }
bad() { echo "FAIL  $1 :: $2" | tee -a "$RESULTS"; FAIL=$((FAIL+1)); }
expect_eq() { [ "$2" = "$3" ] && ok "$1 (=$3)" || bad "$1" "expected $3 got $2"; }

echo "rehearsal $RUN_ID (synthetic data only)" > "$RESULTS"
[ "$(SQ postgres 'show ssl')" = "on" ] || { echo "cluster must have ssl=on"; exit 2; }

# 0. databases and synthetic production-shaped source
for d in src_e2e dst_e2e dst_n3 dst_n4 dst_n6; do SQ postgres "DROP DATABASE IF EXISTS $d" >/dev/null; SQ postgres "CREATE DATABASE $d" >/dev/null; done
"$PSQL" -X -q -h 127.0.0.1 -p "$PORT" -U "$SU" -d src_e2e -v ON_ERROR_STOP=1 -f "$IAD/00-supabase-roles-and-auth.sql" >/dev/null
python3 - > "$RUN/build.sql" <<'PY'
print("""CREATE TABLE auth.users (
  instance_id uuid, id uuid NOT NULL PRIMARY KEY, aud varchar(255), role varchar(255), email varchar(255),
  encrypted_password varchar(255), email_confirmed_at timestamptz, raw_app_meta_data jsonb, raw_user_meta_data jsonb,
  created_at timestamptz, updated_at timestamptz, phone text DEFAULT NULL::character varying,
  phone_confirmed_at timestamptz, is_sso_user boolean NOT NULL DEFAULT false, is_anonymous boolean NOT NULL DEFAULT false,
  confirmed_at timestamptz DEFAULT LEAST(NULL::timestamptz, NULL::timestamptz));
CREATE UNIQUE INDEX users_email_partial_key ON auth.users (email) WHERE (is_sso_user = false);
CREATE UNIQUE INDEX users_phone_key ON auth.users (phone);
CREATE INDEX users_is_anonymous_idx ON auth.users (is_anonymous);
ALTER TABLE auth.users ENABLE ROW LEVEL SECURITY;
CREATE TABLE public.provision_log (id bigserial PRIMARY KEY, fn text NOT NULL);
CREATE TYPE public.tenant_role AS ENUM ('community','patient','professional','admin');
CREATE TABLE public.items (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, name text);
CREATE TABLE public.counters (id serial PRIMARY KEY, val text);
CREATE SEQUENCE public.vtid_seq START WITH 1000;""")
# the eight production trigger functions and triggers on auth.users (names and timing as catalogued 2026-11-17)
fns = ["handle_new_user","initialize_user_journey","initialize_user_preferences","generate_maxina_discount_code",
       "provision_wallet_accounts","cleanup_identifierless_contacts_before_user_delete","provision_platform_user",
       "sync_profile_phone_verification"]
trg = {"handle_new_user":"AFTER INSERT","initialize_user_journey":"AFTER INSERT","initialize_user_preferences":"AFTER INSERT",
       "generate_maxina_discount_code":"AFTER INSERT","provision_wallet_accounts":"AFTER INSERT",
       "cleanup_identifierless_contacts_before_user_delete":"BEFORE DELETE","provision_platform_user":"AFTER INSERT",
       "sync_profile_phone_verification":"AFTER INSERT OR UPDATE OF phone, phone_confirmed_at"}
tname = {"handle_new_user":"on_auth_user_created","initialize_user_journey":"on_user_journey_created",
         "initialize_user_preferences":"on_auth_user_created_preferences","generate_maxina_discount_code":"on_auth_user_created_generate_discount",
         "provision_wallet_accounts":"on_auth_user_created_wallet","cleanup_identifierless_contacts_before_user_delete":"before_auth_user_delete_cleanup_contacts",
         "provision_platform_user":"on_auth_user_platform_provision","sync_profile_phone_verification":"on_auth_user_phone_verification"}
for f in fns:
    print(f"CREATE FUNCTION public.{f}() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $f$ BEGIN INSERT INTO public.provision_log(fn) VALUES ('{f}'); RETURN COALESCE(NEW, OLD); END $f$;")
    print(f"CREATE TRIGGER {tname[f]} {trg[f]} ON auth.users FOR EACH ROW EXECUTE FUNCTION public.{f}();")
# 136 foreign keys into auth.users from public tables (the production count), RLS on, policy on auth.uid()
for i in range(1, 137):
    t = f"t_{i:03d}"
    if i % 2:
        print(f"CREATE TABLE public.{t} (id bigserial PRIMARY KEY, user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE, note text);")
    else:
        print(f"CREATE TABLE public.{t} (id bigserial PRIMARY KEY, user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL, note text);")
    print(f"ALTER TABLE public.{t} ENABLE ROW LEVEL SECURITY;")
    print(f"CREATE POLICY own_rows ON public.{t} FOR SELECT TO authenticated USING (auth.uid() = user_id);")
    print(f"GRANT SELECT ON public.{t} TO authenticated;")
# outbox source functions carry the PRODUCTION URL (replaced by the staging outbox during restore)
for n in ["notify_test_user_confirmation","notify_welcome_discount"]:
    print(f"CREATE FUNCTION public.{n}() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $f$ BEGIN PERFORM 'https://inmkhvwdcuyhnxkgfvsb.supabase.co/functions/v1/{n}'; RETURN NEW; END $f$;")
# data: 261 synthetic users with FAKE hashes (one NULL), items, counters
print("INSERT INTO auth.users (id, email, encrypted_password, created_at)")
print("SELECT ('00000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid, 'rehearsal-user-' || g || '@example.test', CASE WHEN g = 261 THEN NULL ELSE 'FAKE-HASH-' || g END, now() FROM generate_series(1,261) g;")
print("INSERT INTO public.items(name) SELECT 'i' || g FROM generate_series(1,5) g;")
print("INSERT INTO public.counters(val) SELECT 'c' || g FROM generate_series(1,7) g;")
print("SELECT nextval('public.vtid_seq'); SELECT nextval('public.vtid_seq');")
print("TRUNCATE public.provision_log;")
PY
"$PSQL" -X -q -h 127.0.0.1 -p "$PORT" -U "$SU" -d src_e2e -v ON_ERROR_STOP=1 -f "$RUN/build.sql" >/dev/null && ok "synthetic source built (136 FKs, 8 triggers, 261 users with FAKE hashes)" || bad "synthetic source build" "see build.sql"
expect_eq "source fk_to_auth_users" "$(SQ src_e2e "select count(*) from pg_constraint where contype='f' and confrelid='auth.users'::regclass")" 136
expect_eq "source auth.users rows" "$(SQ src_e2e 'select count(*) from auth.users')" 261

# 1. test shim for the one AWS call (the production URL secret) — returns the SYNTHETIC source only
cat > "$RUN/bin/aws" <<SHIM
#!/usr/bin/env bash
if [ "\$1 \$2" = "secretsmanager get-secret-value" ]; then echo "postgresql://${SU}:rehearsal-trust-auth@127.0.0.1:${PORT}/src_e2e"; exit 0; fi
echo "shim: unsupported call" >&2; exit 1
SHIM
chmod +x "$RUN/bin/aws"
export PATH="$RUN/bin:$PATH" OWN_TEST_SHIM=1

# 2. the approved export: no-hashes scope, passphrase generated for the test only
head -c 48 /dev/urandom | base64 > "$RUN/key"; chmod 600 "$RUN/key"
HOME="$RUN/home" AUTH_SCOPE=without-hashes AUTH_KEY_FILE="$RUN/key" bash "$IAD/02-export-cloudshell-allowlisted.sh" > "$EVID/export.log" 2>&1
EXP=$?; expect_eq "export exit (approved no-hashes scope)" "$EXP" 0
OUT=$(ls -dt "$RUN"/home/vitana-migration-* 2>/dev/null | head -1)
[ -n "$OUT" ] && ok "export directory created" || bad "export directory" "none"
expect_eq "temporary role removed after export" "$(SQ src_e2e "select count(*) from pg_roles where rolname='vitana_migration_export'")" 0
expect_eq "dump contains no EXTENSION entries" "$(grep -c ' EXTENSION ' "$OUT/toc.txt")" 0
expect_eq "auth manifest scope" "$(sed -n 's/^auth_scope=//p' "$OUT/auth/MANIFEST.txt")" without-hashes
expect_eq "auth rows exported" "$(sed -n 's/^auth_users_rows=//p' "$OUT/auth/MANIFEST.txt")" 261
( cd "$OUT" && sha256sum -c SHA256SUMS >/dev/null 2>&1 ) && ok "SHA256SUMS verifies (dump, auth, source metrics)" || bad "SHA256SUMS" "mismatch"
if grep -rl 'FAKE-HASH' "$OUT" >/dev/null 2>&1; then bad "no plaintext hash in export" "found"; else ok "no plaintext hash anywhere in the export directory"; fi
cp "$OUT/source-counts.txt" "$EVID/source-counts.txt"

# 3. the shared restore sequence on a fresh target
export P="-h 127.0.0.1 -p $PORT -U $SU -d dst_e2e" AUTH_KEY_FILE="$RUN/key"
"$IAD/restore-core.sh" "$OUT" > "$EVID/restore.log" 2>&1
RC=$?; expect_eq "restore-core exit (approved path)" "$RC" 0
cp "$OUT/target-counts.txt" "$EVID/target-counts.txt" 2>/dev/null || true
cp "$OUT/host-exclusion.txt" "$EVID/host-exclusion.txt" 2>/dev/null || true
D=dst_e2e
expect_eq "target auth.users rows" "$(SQ $D 'select count(*) from auth.users')" 261
expect_eq "target hashes present (must be 0)" "$(SQ $D 'select count(encrypted_password) from auth.users')" 0
expect_eq "target foreign keys into auth.users" "$(SQ $D "select count(*) from pg_constraint where contype='f' and confrelid='auth.users'::regclass")" 136
expect_eq "target triggers on auth.users" "$(SQ $D "select count(*) from pg_trigger where tgrelid='auth.users'::regclass and not tgisinternal")" 8
expect_eq "target RLS on auth.users" "$(SQ $D "select relrowsecurity from pg_class where oid='auth.users'::regclass")" t
expect_eq "target policies (136 own_rows)" "$(SQ $D "select count(*) from pg_policies where policyname='own_rows'")" 136
expect_eq "triggers did not fire during restore (provision_log)" "$(SQ $D 'select count(*) from public.provision_log')" 0
expect_eq "outbox rows queued during restore" "$(SQ $D 'select count(*) from public.outbound_http_requests')" 0
expect_eq "staging outbox points at .invalid host" "$(SQ $D "select count(*) from pg_proc where proname='notify_welcome_discount' and prosrc like '%staging-disabled.invalid%'")" 1
expect_eq "no production host in any function" "$(SQ $D "select count(*) from pg_proc where prosrc like '%inmkhvwdcuyhnxkgfvsb%'")" 0
"$PSQL" -X -q -h 127.0.0.1 -p "$PORT" -U "$SU" -d dst_e2e -c "INSERT INTO public.t_001(user_id, note) VALUES ('00000000-0000-4000-8000-000000000001','own'),('00000000-0000-4000-8000-000000000002','other')" >/dev/null
expect_eq "RLS through the production auth.uid(): user 1 sees only own row" "$(SQ $D "SET ROLE authenticated; SET request.jwt.claims='{\"sub\":\"00000000-0000-4000-8000-000000000001\",\"role\":\"authenticated\"}'; SELECT count(*) FROM public.t_001" | tail -1)" 1
expect_eq "RLS: user 1 cannot see user 2 row" "$(SQ $D "SET ROLE authenticated; SET request.jwt.claims='{\"sub\":\"00000000-0000-4000-8000-000000000001\",\"role\":\"authenticated\"}'; SELECT count(*) FROM public.t_001 WHERE note='other'" | tail -1)" 0
SQ $D "DELETE FROM public.t_001" >/dev/null
# two-user RLS isolation (real rows, real roles; the authenticated role is set per user through request.jwt.claims)
U1='00000000-0000-4000-8000-000000000001'; U2='00000000-0000-4000-8000-000000000002'
"$PSQL" -X -q -h 127.0.0.1 -p "$PORT" -U "$SU" -d dst_e2e -c "INSERT INTO public.t_001(user_id, note) VALUES ('$U1','own-1'),('$U2','own-2')" >/dev/null
rls() { SQ $D "SET ROLE authenticated; SET request.jwt.claims='{\"sub\":\"$1\",\"role\":\"authenticated\"}'; SELECT $2" | tail -1; }
expect_eq "RLS user1 sees exactly its own row" "$(rls $U1 "count(*) FROM public.t_001")" 1
expect_eq "RLS user1 sees the row with its own note" "$(rls $U1 "count(*) FROM public.t_001 WHERE note='own-1'")" 1
expect_eq "RLS user1 cannot see user2 row" "$(rls $U1 "count(*) FROM public.t_001 WHERE note='own-2'")" 0
expect_eq "RLS user2 sees exactly its own row" "$(rls $U2 "count(*) FROM public.t_001")" 1
expect_eq "RLS user2 cannot see user1 row" "$(rls $U2 "count(*) FROM public.t_001 WHERE note='own-1'")" 0
expect_eq "RLS anonymous role is denied (no grant on the table)" "$("$PSQL" -X -At -h 127.0.0.1 -p "$PORT" -U "$SU" -d "$D" -c "SET ROLE anon; SELECT count(*) FROM public.t_001" 2>&1 | grep -c "permission denied")" 1
SQ $D "DELETE FROM public.t_001" >/dev/null

# cron: no pg_cron extension and no cron schema, so no job can exist on staging
expect_eq "cron extension absent" "$(SQ $D "select count(*) from pg_extension where extname='pg_cron'")" 0
expect_eq "cron schema absent (no cron.job table)" "$(SQ $D "select count(*) from information_schema.schemata where schema_name='cron'")" 0

# outbox, genuinely executed: the restored trigger function fires on a probe insert and queues a row for the .invalid host
SQ $D "CREATE TABLE public.rehearsal_outbox_probe (id int); CREATE TRIGGER probe AFTER INSERT ON public.rehearsal_outbox_probe FOR EACH ROW EXECUTE FUNCTION public.notify_test_user_confirmation(); INSERT INTO public.rehearsal_outbox_probe VALUES (1);" >/dev/null
expect_eq "outbox probe queued exactly one row" "$(SQ $D "select count(*) from public.outbound_http_requests")" 1
expect_eq "outbox row targets the .invalid host (never production)" "$(SQ $D "select count(*) from public.outbound_http_requests where url like 'https://staging-disabled.invalid/%' and status='pending'")" 1
expect_eq "outbox row carries no production reference" "$(SQ $D "select count(*) from public.outbound_http_requests where url || coalesce(body::text,'') like '%inmkhvwdcuyhnxkgfvsb%'")" 0
SQ $D "DROP TABLE public.rehearsal_outbox_probe; TRUNCATE public.outbound_http_requests;" >/dev/null

# 4. negative tests — each must refuse
# N1: a with-hashes export is refused by the export itself (and the role is still removed)
HOME="$RUN/home-n1" AUTH_SCOPE=with-hashes AUTH_KEY_FILE="$RUN/key" bash "$IAD/02-export-cloudshell-allowlisted.sh" > "$EVID/n1.log" 2>&1; N1=$?
[ "$N1" = 7 ] && grep -q "must be exactly without-hashes" "$EVID/n1.log" && ok "N1 with-hashes scope refused by export (exit 7)" || bad "N1 with-hashes refusal" "exit $N1"
expect_eq "N1 role removed after refusal" "$(SQ src_e2e "select count(*) from pg_roles where rolname='vitana_migration_export'")" 0
# N2: a passphrase file with the wrong mode is refused
cp "$RUN/key" "$RUN/key-644"; chmod 644 "$RUN/key-644"
HOME="$RUN/home-n2" AUTH_SCOPE=without-hashes AUTH_KEY_FILE="$RUN/key-644" bash "$IAD/02-export-cloudshell-allowlisted.sh" > "$EVID/n2.log" 2>&1; N2=$?
[ "$N2" != 0 ] && grep -q "mode 600" "$EVID/n2.log" && ok "N2 passphrase file mode 644 refused (exit $N2)" || bad "N2 key-mode refusal" "exit $N2"
# N3: manifest relabelled to with-hashes (checksums regenerated, so only the scope guard can refuse)
N3D="$RUN/n3"; rm -rf "$N3D"; cp -r "$OUT" "$N3D"; sed -i 's/^auth_scope=without-hashes/auth_scope=with-hashes/' "$N3D/auth/MANIFEST.txt"
( cd "$N3D" && { find dump -type f; find auth -type f; echo source-counts.txt; } | sort | xargs sha256sum > SHA256SUMS )
P="-h 127.0.0.1 -p $PORT -U $SU -d dst_n3" "$IAD/restore-core.sh" "$N3D" > "$EVID/n3.log" 2>&1; N3=$?
[ "$N3" = 9 ] && ok "N3 relabelled scope refused before any load (exit 9)" || bad "N3 scope guard" "exit $N3"
expect_eq "N3 nothing loaded" "$(SQ dst_n3 "select count(*) from pg_tables where schemaname='public'")" 0
# N4: source metrics altered (checksums regenerated): the full restore runs, then the preservation check refuses
N4D="$RUN/n4"; rm -rf "$N4D"; cp -r "$OUT" "$N4D"; sed -i 's/^fk_constraints|.*/fk_constraints|999/' "$N4D/source-counts.txt"
( cd "$N4D" && { find dump -type f; find auth -type f; echo source-counts.txt; } | sort | xargs sha256sum > SHA256SUMS )
P="-h 127.0.0.1 -p $PORT -U $SU -d dst_n4" AUTH_KEY_FILE="$RUN/key" "$IAD/restore-core.sh" "$N4D" > "$EVID/n4.log" 2>&1; N4=$?
[ "$N4" = 11 ] && ok "N4 altered source metric refused by preservation check (exit 11)" || bad "N4 preservation check" "exit $N4"
# N5: an injected production reference after the outbox replacement is found by the host check
SQ dst_e2e "CREATE OR REPLACE FUNCTION public.tmp_injected() RETURNS text LANGUAGE sql AS \$\$ select 'inmkhvwdcuyhnxkgfvsb' \$\$" >/dev/null
N5=$("$PSQL" -X -At -h 127.0.0.1 -p "$PORT" -U "$SU" -d dst_e2e -f "$IAD/06-production-host-exclusion-check.sql" | awk -F'|' '$2!=0' | wc -l)
[ "$N5" -ge 1 ] && ok "N5 injected production reference detected by host check ($N5 class)" || bad "N5 host check" "not detected"
SQ dst_e2e "DROP FUNCTION public.tmp_injected()" >/dev/null
# N6: a data file that really contains hashes, with an honest without-hashes manifest: the destination guard refuses (exit 8)
N6D="$RUN/n6"; rm -rf "$N6D"; cp -r "$OUT" "$N6D"; rm -f "$N6D/auth/auth-users-data.enc"
"$PSQL" -X -h 127.0.0.1 -p "$PORT" -U "$SU" -d src_e2e -c "\\copy (SELECT * FROM auth.users ORDER BY id) TO STDOUT" | openssl enc -aes-256-cbc -pbkdf2 -iter 600000 -salt -pass file:"$RUN/key" -out "$N6D/auth/auth-users-data.enc"
( cd "$N6D" && { find dump -type f; find auth -type f; echo source-counts.txt; } | sort | xargs sha256sum > SHA256SUMS )
P="-h 127.0.0.1 -p $PORT -U $SU -d dst_n6" AUTH_KEY_FILE="$RUN/key" "$IAD/restore-core.sh" "$N6D" > "$EVID/n6.log" 2>&1; N6=$?
[ "$N6" = 8 ] && ok "N6 hash-bearing data refused by destination guard (exit 8)" || bad "N6 hash guard" "exit $N6"

echo "----" | tee -a "$RESULTS"; echo "PASS=$PASS FAIL=$FAIL" | tee -a "$RESULTS"
# the passphrase and the scratch copies never leave the scratch directory
rm -rf "$RUN"; echo "scratch removed (passphrase and copies)" >> "$RESULTS"
[ "$FAIL" = 0 ]
