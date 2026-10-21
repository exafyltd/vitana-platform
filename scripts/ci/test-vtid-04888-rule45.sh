#!/usr/bin/env bash
# VTID-04888: rule-45 exclusion migration + data fix-up. On a throwaway local Postgres with the fixture
# (supabase/tests/vtid_04888_fixture.sql), apply the migration twice and the fix-up twice, run the
# assertions, then check the fix-up's guard aborts when a dependent row exists, and that the rollback
# restores the captured live function bodies.
# Needs a local PostgreSQL server (initdb/pg_ctl), e.g. apt postgresql-16. Never points at a live database.
# pgvector is not available here: vector(N) is rewritten to text (the fixture stubs <=> for text).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
MIGRATION="$ROOT/supabase/migrations/20261005120000_vtid_04888_rule45_intents_profiles.sql"
FIXUP="$ROOT/supabase/migrations/data-fixups/20261005120100_vtid_04888_rule45_cleanup.sql"
FIXTURE="$ROOT/supabase/tests/vtid_04888_fixture.sql"
TESTS="$ROOT/supabase/tests/vtid_04888_rule45.test.sql"
ROLLBACK="$ROOT/docs/validation/VTID-04888/rollback.sql"

PGBIN="${PGBIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)}"
[ -x "$PGBIN/initdb" ] || { echo "initdb not found (set PGBIN)"; exit 2; }

WORK="$(mktemp -d)"
RUN_AS=()
if [ "$(id -u)" = "0" ]; then
  chown postgres "$WORK"
  RUN_AS=(sudo -u postgres)
fi
PORT="${PGPORT_TEST:-55437}"
cleanup() { "${RUN_AS[@]}" "$PGBIN/pg_ctl" -D "$WORK/data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$WORK"; }
trap cleanup EXIT

novector() { sed -E 's/vector\(([0-9]+)\)/text/g' "$1" > "$WORK/$(basename "$1")"; chmod o+r "$WORK/$(basename "$1")"; echo "$WORK/$(basename "$1")"; }
M="$(novector "$MIGRATION")"; F="$(novector "$FIXUP")"; X="$(novector "$FIXTURE")"; T="$(novector "$TESTS")"; R="$(novector "$ROLLBACK")"

"${RUN_AS[@]}" "$PGBIN/initdb" -D "$WORK/data" -U postgres -A trust >/dev/null
"${RUN_AS[@]}" "$PGBIN/pg_ctl" -D "$WORK/data" -o "-p $PORT -k $WORK -c listen_addresses=''" -w start >/dev/null
PSQL=("${RUN_AS[@]}" psql -X -q -v ON_ERROR_STOP=1 -h "$WORK" -p "$PORT" -U postgres -d postgres)

"${PSQL[@]}" -f "$X"
"${PSQL[@]}" -f "$M"
"${PSQL[@]}" -f "$M"            # idempotent
"${PSQL[@]}" -f "$F"
"${PSQL[@]}" -f "$F"            # idempotent
"${PSQL[@]}" -f "$T"

# Guard: a dependent row on a match of an excluded account aborts the whole fix-up.
"${PSQL[@]}" -c "ALTER TABLE public.intent_matches DISABLE TRIGGER trg_intent_matches_skip_excluded;
  INSERT INTO public.intent_matches (match_id, intent_a_id, intent_b_id, state) VALUES
    ('20000000-0000-0000-0000-0000000000ff', '10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-0000000000a2', 'new');
  INSERT INTO public.intent_disputes (match_id) VALUES ('20000000-0000-0000-0000-0000000000ff');
  ALTER TABLE public.intent_matches ENABLE TRIGGER trg_intent_matches_skip_excluded;"
if "${PSQL[@]}" -f "$F" 2>"$WORK/guard.err"; then
  echo "FAIL: fix-up ran although a dependent row exists"; exit 1
fi
grep -q "VTID-04888 fix-up aborted" "$WORK/guard.err" || { cat "$WORK/guard.err"; echo "FAIL: wrong guard error"; exit 1; }
[ "$("${PSQL[@]}" -tA -c "SELECT count(*) FROM public.intent_matches WHERE match_id = '20000000-0000-0000-0000-0000000000ff'")" = "1" ] \
  || { echo "FAIL: aborted fix-up still deleted"; exit 1; }
echo "fix-up guard aborts on dependent rows: ok"

# Rollback restores the captured bodies and removes the triggers and helper.
"${PSQL[@]}" -f "$R"
[ "$("${PSQL[@]}" -tA -c "SELECT count(*) FROM pg_proc WHERE proname IN ('search_intent_catalog_v2','compute_intent_matches_v2','search_intent_catalog','compute_intent_matches') AND prosrc LIKE '%VTID-04888%'")" = "0" ] \
  || { echo "FAIL: rollback left the predicates"; exit 1; }
[ "$("${PSQL[@]}" -tA -c "SELECT count(*) FROM pg_trigger WHERE tgname IN ('trg_gcp_hide_excluded_accounts','trg_service_bot_hide_profile','trg_test_actor_hide_profile','trg_intent_matches_skip_excluded')")" = "0" ] \
  || { echo "FAIL: rollback left triggers"; exit 1; }
[ "$("${PSQL[@]}" -tA -c "SELECT count(*) FROM pg_proc WHERE proname = 'is_excluded_account'")" = "0" ] \
  || { echo "FAIL: rollback left the helper"; exit 1; }
echo "rollback: ok"
echo "VTID-04888 harness: all checks passed"
