#!/usr/bin/env bash
# VTID-05010: voice diary episode repair (data fix-up). On a throwaway local
# Postgres with a minimal fixture: apply the fix-up twice (2 episodes, then still
# 2 — idempotent), check the episode shape, and check the guard aborts without
# writing when a user has no primary tenant.
# Needs a local PostgreSQL server (initdb/pg_ctl), e.g. apt postgresql-16. Never points at a live database.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
FIXUP="$ROOT/supabase/migrations/data-fixups/20261009200000_vtid_05010_voice_diary_episode_repair.sql"

PGBIN="${PGBIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)}"
[ -x "$PGBIN/initdb" ] || { echo "initdb not found (set PGBIN)"; exit 2; }

WORK="$(mktemp -d)"
RUN_AS=()
if [ "$(id -u)" = "0" ]; then
  chown postgres "$WORK"
  RUN_AS=(sudo -u postgres)
fi
PORT="${PGPORT_TEST:-55438}"
cleanup() { "${RUN_AS[@]}" "$PGBIN/pg_ctl" -D "$WORK/data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$WORK"; }
trap cleanup EXIT

"${RUN_AS[@]}" "$PGBIN/initdb" -D "$WORK/data" -U postgres >/dev/null
"${RUN_AS[@]}" "$PGBIN/pg_ctl" -D "$WORK/data" -o "-p $PORT -k $WORK -c listen_addresses=''" -w start >/dev/null
cp "$FIXUP" "$WORK/fixup.sql"; chmod o+r "$WORK/fixup.sql"
PSQL=("${RUN_AS[@]}" psql -X -q -v ON_ERROR_STOP=1 -h "$WORK" -p "$PORT" -U postgres -d postgres)

A=a1a77e84-6db9-466d-8257-9376f0a6bc4f
B=6b40de35-72c3-42da-9bba-5d82c27cbe96
U1=11111111-1111-1111-1111-111111111111
U2=22222222-2222-2222-2222-222222222222
T=2e7528b8-472a-4356-88da-0280d4639cce

"${PSQL[@]}" <<SQL
CREATE TABLE public.diary_entries (id uuid PRIMARY KEY, user_id uuid NOT NULL, text text, source text, tags text[], created_at timestamptz NOT NULL);
CREATE TABLE public.user_tenants (user_id uuid NOT NULL, tenant_id uuid NOT NULL, is_primary boolean NOT NULL DEFAULT false);
CREATE TABLE public.memory_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, user_id uuid NOT NULL, active_role text,
  category_key text NOT NULL, source text NOT NULL, content text NOT NULL, content_json jsonb, importance int NOT NULL DEFAULT 10,
  occurred_at timestamptz NOT NULL DEFAULT now(), created_at timestamptz NOT NULL DEFAULT now(),
  sensitivity text NOT NULL DEFAULT 'standard', embedding text);
INSERT INTO public.user_tenants VALUES ('$U1', '$T', true), ('$U2', '$T', true);
INSERT INTO public.diary_entries VALUES
  ('$A', '$U1', 'first voice entry', 'voice', '{diary,voice,orb}', '2026-09-24 15:52:50+00'),
  ('$B', '$U2', 'second voice entry', 'voice', '{diary,voice,orb}', '2026-09-26 09:14:45+00'),
  ('33333333-3333-3333-3333-333333333333', '$U1', 'untouched', 'voice', '{diary}', '2026-09-27 10:00:00+00');
SQL

fail() { echo "FAIL: $*"; exit 1; }
q() { "${PSQL[@]}" -tA -c "$1"; }

"${PSQL[@]}" -f "$WORK/fixup.sql"
[ "$(q 'select count(*) from memory_items')" = "2" ] || fail "first run should insert 2 episodes"

"${PSQL[@]}" -f "$WORK/fixup.sql"
[ "$(q 'select count(*) from memory_items')" = "2" ] || fail "second run must insert nothing"

SHAPE="$(q "select string_agg(format('%s|%s|%s|%s|%s|%s|%s|%s', user_id, tenant_id, coalesce(active_role,'null'), source, category_key, importance, occurred_at = (select created_at from diary_entries d where d.id::text = content_json->>'diary_entry_id'), content_json::text), E'\n' order by content_json->>'diary_entry_id') from memory_items")"
EXPECTED="$U2|$T|null|diary|notes|50|t|{\"kind\": \"diary\", \"tags\": [\"diary\", \"voice\", \"orb\"], \"diary_source\": \"voice\", \"diary_entry_id\": \"$B\"}
$U1|$T|null|diary|notes|50|t|{\"kind\": \"diary\", \"tags\": [\"diary\", \"voice\", \"orb\"], \"diary_source\": \"voice\", \"diary_entry_id\": \"$A\"}"
[ "$SHAPE" = "$EXPECTED" ] || fail "episode shape differs:\n$SHAPE\n--- expected ---\n$EXPECTED"
[ "$(q "select content from memory_items where content_json->>'diary_entry_id' = '$A'")" = "first voice entry" ] || fail "content must be the diary text"

# Guard: no primary tenant for one user -> abort, nothing written.
q "delete from memory_items; update user_tenants set is_primary = false where user_id = '$U2'" >/dev/null
if "${PSQL[@]}" -f "$WORK/fixup.sql" 2>"$WORK/err"; then fail "guard should abort without a primary tenant"; fi
grep -q "expected 2 diary rows with a primary tenant, found 1" "$WORK/err" || fail "guard message missing: $(cat "$WORK/err")"
[ "$(q 'select count(*) from memory_items')" = "0" ] || fail "aborted run must write nothing"

echo "PASS: VTID-05010 diary episode repair (insert 2, idempotent, shape, guard)"
