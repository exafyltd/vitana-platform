# Routine: migration-backlog

**Schedule:** `0 10 * * *` (daily 10:00 UTC)
**Catalog row:** `routines.name = 'migration-backlog'`
**OASIS VTID for emitted events:** `VTID-02018`

## Autonomy contract

Compares `supabase/migrations/*.sql` files in the cloned repo against `schema_migrations` applied in Supabase (via gateway audit endpoint). Lists migrations on disk but never applied. Emits OASIS event when the gap exceeds 5 unapplied migrations. **No briefs.**

| Catalog state | Meaning |
|---|---|
| 🟢 `success` | Backlog ≤ 5. |
| 🟡 `partial` | Backlog > 5 → OASIS event emitted. |
| 🔴 `failure` | Audit endpoint or repo file listing unreachable. |

## Steps

1. `POST $GATEWAY_URL/api/v1/routines/migration-backlog/runs` (X-Routine-Token).
2. **List local migrations** — `ls supabase/migrations/*.sql` in the cloned repo. Each filename starts with a timestamp prefix (e.g. `20260427180000_vtid_02006_routines_tier_b.sql`). Extract just the `<ts>` prefix as the version.
3. **List applied** — `GET $GATEWAY_URL/api/v1/routines/audits/migration-backlog` → `{ applied_count, applied_versions: [...], latest_applied }`.
4. **Compute gap** — `unapplied = local_versions - applied_versions` (set difference). Sort by version ascending.
5. Threshold: `breach = unapplied.length > 5`.
6. If breach: `POST /api/v1/events/ingest` topic `migrations.backlog.detected`, vtid `VTID-02018`, payload `{ unapplied_count, unapplied_versions: unapplied.slice(0, 20), latest_local, latest_applied }`.
7. PATCH:
   - No breach: `success`, `"✅ Migration backlog clean: {unapplied.length} unapplied (≤5)"`.
   - Breach: `partial`, `"⚠️ Migration backlog: {unapplied.length} unapplied. OASIS event emitted, self-healing notified."`.

## Hard rules
- Plain `curl` + `ls`. Wall-clock cap 1 minute. No briefs.
- `unapplied` is "files on disk not in applied list" — this surfaces forward backlog only, not anything weird like applied-without-file.
