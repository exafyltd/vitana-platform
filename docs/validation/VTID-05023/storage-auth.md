# VTID-05023 part 8b — Storage authorization after the flip

Read live, read-only, Supabase project `inmkhvwdcuyhnxkgfvsb`, 2026-10-10.

Storage stays on Supabase (option B). Its `storage.objects` policies run on
Supabase, so any policy that reads a `public` table keeps reading Supabase's
copy, which is write-frozen after the flip. Those tables have to keep receiving
Aurora's changes.

## Policies that read `public` (2 of 63 `storage.objects` policies)

| policy | reads | tables |
|---|---|---|
| `Users can view chat attachments` (SELECT, bucket `chat-attachments`) | `public.can_access_chat_attachment(name)`, SECURITY DEFINER | `chat_messages` (DM recipient), `chat_group_members` (group member), `thread_participants`, `global_thread_participants` (legacy threads) |
| `Users can download their own voucher PDFs` (SELECT, bucket `voucher-pdfs`) | inline `EXISTS` | `voucher_orders` |

The other 61 policies use only `bucket_id`, `storage.foldername(name)`,
`auth.uid()`, `auth.role()` or `auth.email()`. There are no `realtime` schema
policies. (`media_uploads` was named in the plan as an example; no storage
policy reads it.)

| table | rows (est.) | size | primary key | user triggers |
|---|---|---|---|---|
| chat_messages | 50,997 | 62 MB | id | `trg_notify_chat_message` |
| chat_group_members | 331 | 152 kB | (group_id, user_id) | none |
| thread_participants | 10 | 64 kB | id | `trg_guard_thread_participant_update` |
| global_thread_participants | 118 | 120 kB | id | `trg_guard_global_thread_participant_update` |
| voucher_orders | 75 | 176 kB | id | `voucher_orders_updated_at` |

## Replacement

`scripts/aws/aurora-to-supabase-cdc.sh --scope storage-auth`: a CDC-only DMS
task Aurora → Supabase for these 5 tables. It runs for as long as Storage stays
on Supabase. `--scope rollback` is the part-12(i) task for every other public
table, minus the Aurora-only tables. It is stopped and deleted when the T+2h
window closes.

**Deviation from the plan (recorded for Gate 2):** the plan wanted the target
in replica mode (`AfterConnectScript=SET session_replication_role=replica`).
Supabase's `postgres` role is not a superuser and has no SET privilege on
`session_replication_role` (`has_parameter_privilege` returns false), so DMS
could not connect with that setting.

Instead, `scripts/aws/supabase-cutover-reverse-cdc-triggers.sql` snapshots and
disables every user trigger on Supabase `public` tables at the flip:

- That is 152 tables and 239 triggers. All are owned by `postgres` and all are enabled today.
- FK triggers stay enabled.
- `supabase-cutover-reverse-cdc-triggers-rollback.sql` restores the exact
  snapshot.

Nothing else writes Supabase `public` after the flip (write freeze plus drift
monitor). Without this step, `trg_notify_chat_message` would notify every
chat message a second time.

## Window order

1. `supabase-cutover-unschedule.sql`
2. `supabase-cutover-reverse-cdc-triggers.sql`
3. After the final load, after-load and backfill, and before the gateway flip:
   start both CDC tasks.

Rollback, in this order:

1. Stop the tasks.
2. `supabase-cutover-reverse-cdc-triggers-rollback.sql`
3. `supabase-cutover-unschedule-rollback.sql`

Prerequisites:

- `rds.logical_replication=1` on Aurora (reboot).
- `aws dms test-connection` on both reverse endpoints before the window.

Proven on the Aurora clone in part 10: an existing member opens an existing
chat attachment (read-only).

Test: `npm run test:reverse-cdc`.

**Schema rule after the flip.** Migrations go to Aurora only (part 8). A column
added on Aurora to one of the 5 tables (or to any table during the rollback
window) must also be added on Supabase first. Otherwise DMS suspends that
table (`TableErrorPolicy: SUSPEND_TABLE`). The drift monitor (part 11) excludes
the tables these tasks write.
