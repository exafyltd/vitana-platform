# Plan sparring record — VTID-05054 (Health Hub WP4b-2 / D5 + D7)

- **Parent program:** VTID-05020 (Health Hub plan r7, §1 D5 + D7, §5 Phase 0).
- **Sparring session:** `plan_sparring_sessions.id = 01589db1-56f4-4f6d-8677-8a139f0d9441`, shared with VTID-05053 (WP4b-1, the vitana-v1 half of the same plan). The VTID was allocated with `p_sparring_id`. VTID-05034 and its first replacement VTID-05051 were tombstoned by the allocated-orphan reaper before their titles could be written; this work carries VTID-05054.
- **Partner:** `plan-sparring-partner` agent (read-only, independent). **Rounds:** 2. **Verdict:** CONVERGED.
- **Plan hashes:** round 1 `cbe23495913cf273b4f595d63747f9faa4248ba1ff2f7df5352f3725c84ae44c`, **final `4ebbbc59665e3d4efa2abc69e3f8d8a5550de26410f6bd8c28a03c9a42851bbb`**.
- **Owner approval:** d.stevanovic@exafy.io in the Claude Code session, 2026-10-10 — "Yes to both plans" (Gate 1 approval of the Health Hub program plan, VTID-05020; D5 and D7 are in it).
- **Approval basis:** the owner's Gate 1 approval of the program plan ("Yes to both plans", 2026-10-10). D5 and D7 are in the approved plan.

## Round 1 — NOT CONVERGED

| # | Sev | Finding | Answer |
|---|-----|---------|--------|
| F1 | major | The bucket list misses `feedback-attachments` (and `covers`). | Accepted: `feedback-attachments` added (WP4b-1). `covers` deferred with the reason recorded in STATUS.md. |
| F2 | major | Stopping AP-0607 must account for the AP-0608 cascade and its English copy. | Accepted: with no `health.biomarkers.stored`, the AP-0608 → AP-0612 cascade cannot start. AP-0608's English copy is deferred to STATUS.md. |
| F3 | major | Storage listing is non-recursive, and offset paging skips objects while deleting. | Accepted: prefix recursion with no offset (WP4b-1). |
| F4, F6 | minor | Further details of the recursive deletion. | Accepted: folded into change 1 (prefix-based recursion, WP4b-1). |
| F5 | minor | Schedule the purge with the existing `setInterval` pattern in `index.ts`. | Accepted: change 3. |
| F7 | minor | The edge function cannot be integration-tested on staging without writes. | Accepted: Vitest unit tests only (WP4b-1). |

## Round 2 — CONVERGED

| # | Sev | Finding | Answer |
|---|-----|---------|--------|
| F8 | minor | Informational. | Noted. No change. |

## Final plan

<!-- plan:begin -->

## Meta
- **Change class:** standard. One Supabase edge-function change (vitana-v1), one gateway handler change
  (vitana-platform), tests.
- **No migration.** No new route.
- **Two PRs, one VTID each** (one per repo): WP4b-1 for erasure, WP4b-2 for D7.

## Facts (vitana-v1 origin/main 51a2058, vitana-platform origin/main 6c275e7; live DB read-only 2026-10-10)
1. **Account deletion.**
   - `supabase/functions/request-account-deletion/index.ts` calls `erase_user_data` (L~221) and then
     `deleteUserStorageFiles` (L48-100).
   - The latter lists `storage.from(bucket).list(userId, { limit: 1000 })` **non-recursively** (L66-68, bridge path
     L64). It removes `${userId}/${f.name}` for every entry (L82).
   - Supabase Storage returns sub-folders as entries. Removing a folder path deletes nothing, so every file below
     `<user>/<sub-folder>/` survives.
2. **`USER_STORAGE_BUCKETS`** (L38-46) is avatars, diary-photos, chat-attachments, media-uploads, voucher-pdfs,
   stream-recordings and event-images. **`health-reports` is missing**, although the app uploads lab reports there:
   `HealthReportUploadSheet.tsx` L~96, path `${user.id}/${category}/${ts}_${name}`.
3. **Live storage (read-only):**

   | Bucket | Objects | Nested | Notes |
   |---|---|---|---|
   | `health-reports` | 25 | 25 | |
   | `chat-attachments` | 67 | 67 | |
   | `media-uploads` | 441 | 416 | |
   | `avatars` | 91 | 4 | |
   | `diary-photos` | 5 | 0 | |
   | `event-images` | 50 | 0 | no `owner_id` |
   | `voucher-pdfs` | 28 | 0 | no `owner_id` |

   For every owned object, the first path segment equals `owner_id`. So a recursive walk of `<userId>/` reaches
   every file a member uploaded.
4. **`erase_user_data`** (`vitana-platform` migration `20261001120000_vtid_04765_erase_user_data.sql`) deletes from
   every public table with a `user_id` column except the documented retain list.
   - `partner_health_result_inbox` has no `user_id` column (it has `candidate_user_ids`), so it is never erased.
     Live: 0 rows.
   - `connector_webhooks_log` rows with `user_id` NULL are never erased. Live: 3 rows, all from 2026-04, with test
     payloads.
5. **D7.**
   - AP-0607 (`services/automation-handlers/health-wellness.ts` L74-94) notifies the member "Your lab report is
     being analyzed. Results will be ready soon." and emits `health.biomarkers.stored`, but no parser exists.
   - The notice is hard-coded English, which breaks the server-i18n rule (`backend.md` §13b).
   - AP-0608 subscribes to `health.biomarkers.stored` (`automation-registry.ts` L539) and would then run on nothing.
   - Live: `automation_runs` has 0 rows for AP-0607 or AP-0608. The defect is latent, not yet reached a member.

## Changes
**WP4b-1 (vitana-v1, erasure):**
1. **Recursive, prefix-based deletion (round-1 F3/F4/F6).**
   - `deleteUserStorageFiles` walks `<userId>/` per prefix and calls `list(prefix, { limit: 1000 })` only. It never
     uses `offset`, so the gateway storage-bridge contract (`{ bucket, prefix, limit }`) is untouched and there is no
     cross-repo coupling.
   - **Files vs folders.** On the direct Supabase path, an entry without `id` is a folder. On the bridge path, `id`
     is stripped, so an entry counts as a folder when listing `<prefix>/<name>` returns entries. That costs one extra
     list call per entry, which is acceptable for a one-off erasure.
   - **Paging without offset.** The walk deletes the files it listed (batches of ≤ 1000), then lists the same prefix
     again until a listing returns no files. Each pass removes what it saw, so no offset is needed. A pass that
     deletes nothing ends the loop, which guards against infinite repetition.
   - Per bucket it reports `{ deleted, error }` as today.
   - `STORAGE_BRIDGE_PROVIDER` defaults to `supabase` (`_shared/storage-bridge-client.ts` L61-64); both paths are
     unit-tested.
2. **Buckets (round-1 F1).**
   - `health-reports` and `feedback-attachments` join `USER_STORAGE_BUCKETS`. Both hold member uploads under
     `<userId>/` (`HealthReportUploadSheet.tsx`, `MyBiology.tsx`, `UnifiedCaptureCard.tsx` L430, `MobileSupport.tsx`
     L400).
   - `covers` is **deferred with a reason.** It holds event, meetup and live-room cover images under
     `${user?.id ?? 'public'}/` that published community events may still reference after the uploader leaves.
     Deleting them needs the event-ownership decision. Recorded in STATUS.md.
3. **Verification after delete.** A second recursive list must return 0 objects for the user in each bucket.
   Otherwise the request row records `storage_incomplete` with the counts, so it stays visible, never silent.
4. **Tests (Deno/Vitest, as the existing `src/lib/erase-user-data.test.ts` pattern):**
   - a fake storage client with nested folders deletes every file at every depth, on both the direct path and the
     bridge path (no `id` on bridge entries);
   - more than 1000 files in one folder are all deleted by repeated passes, without offset;
   - a pass that deletes nothing stops the loop;
   - `health-reports` is included;
   - a residual file → `storage_incomplete`.

**WP4b-2 (vitana-platform):**
5. **D7.** AP-0607 sends no notice and emits no `health.biomarkers.stored` while no parser exists. It records a run
   with `actionsTaken: 0` and an OASIS info event `health.lab_report.parse_unavailable`.
   - The notice and its i18n catalog key return with the parser WP. They are not hard-coded.
   - AP-0608 is unchanged; it simply never fires until the parser emits the event. Because AP-0607 no longer emits
     `health.biomarkers.stored`, the AP-0608 → `health.biomarker.critical`/AP-0612 cascade cannot start (round-1 F2).
   - AP-0608's own hard-coded English notice ("Lab Results Analyzed", `health-wellness.ts` L123-126) is the same
     pre-existing server-i18n violation. It is deferred to the parser WP, where AP-0608 first becomes reachable, and
     recorded in STATUS.md.
6. **D5 database tail.**
   - The account-erasure path also deletes `connector_webhooks_log` rows whose payload references the user's vendor
     ids. This is deferred: it needs the payload user-id extraction designed in D5's retention WP.
   - In this WP: a **90-day retention purge** of `connector_webhooks_log`, using the service role and reported to
     OASIS.
     - Following the existing `setInterval` pattern in `index.ts` (round-1 F5), it runs once at boot and then every
       24 h, gated by `CONNECTOR_WEBHOOK_LOG_PURGE_ENABLED=true`.
     - It runs on every instance without leader election: the statement
       `DELETE … WHERE received_at < now() - interval '90 days'` is idempotent, so concurrent runs delete the same set
       at most once. The 3 live rows are older than 90 days and are purged by the first run.
     Purging them is a production write and runs only after Gate 2.
   - `partner_health_result_inbox` is deferred, with its 0 rows: the D8 work package decides member linkage there.
7. **Tests (Jest):**
   - AP-0607 emits neither the notice nor the event;
   - the purge deletes only rows older than 90 days, with a dry-run count, over a fake client;
   - a source scan finds no English notification literal in AP-0607.

## Rollout
- The **edge function** deploys to the production Supabase project, which is the only project. That deploy is a
  production change, so it is listed in Gate 2 and deployed only after "yes" (via the repo's edge-function deploy
  path).
- The **gateway** change follows merge → staging → STAGING-VERIFY → Gate 2.
- The **purge job** is gated by `CONNECTOR_WEBHOOK_LOG_PURGE_ENABLED=true`, off on staging. Staging shares the
  database and must not purge. It is set only on production at publish.

## Staging verification (read-only)
- Gateway: the `existing` Jest suites for AP-0607 and the purge, plus the smoke suite. No POST, no purge on staging
  (flag off, asserted by a unit test of the flag default).
- **Frontend edge function:** verified by Vitest unit tests only (round-1 F7). No staging integration test is
  possible, because invoking the function irreversibly deletes a real account on the shared production database.
  This is stated in Gate 2.

## Not in scope
- `partner_health_result_inbox` linkage and erasure (→ D8).
- Payload-based user matching in `connector_webhooks_log` (→ D5 retention WP).
- `event-images`/`voucher-pdfs`: these have no `owner_id`; they are tenant/event assets, not member uploads.
- `covers`: deferred pending the event-ownership decision (see Change 2).
- AP-0608's hard-coded English notice: deferred to the parser WP (see Change 5).

<!-- plan:end -->
