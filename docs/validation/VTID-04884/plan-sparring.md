# Plan sparring record — VTID-04884

- **Plan hash** (sha256 of the text between the plan markers): `e5f8228d150bd390c73686fda50882e6dcb59fc1dae33508491810a1387f28a9`. It was also passed as `p_plan_hash` to `allocate_global_vtid`.
- **Change class:** light.
- **Partner:** `plan-sparring-partner` agent (read-only).
- **Rounds:** 2.
  - Round 1: NOT CONVERGED. Majors F2 and F3; minors F1, F4, F5, F6, F7.
  - Round 2: CONVERGED. All seven findings closed, nothing new.
- **Owner approval:** 2026-10-05, in session ("Yes").

## Round 1 findings and responses
- F1 [minor] The insert is at :4149, not :4148. ACCEPTED.
- F2 [major] Error handling for `.select().single()` on the insert path. ACCEPTED: an error or no row skips the episode write and logs, non-fatal as before.
- F3 [major] Where the coalesce path's `diary_entry_id` comes from. ACCEPTED: `recentEntry.id`.
- F4 [minor] The data repair must be idempotent. ACCEPTED: rows that already have an episode are skipped.
- F5 [minor] The guard must catch multi-line inserts. ACCEPTED: multi-line pattern, and it must find both known writers.
- F6 [minor] Confirm the scope. Confirmation only.
- F7 [minor] Client privilege. ANSWERED: `writeMemoryItemWithIdentity` builds its own service-role client (orb-memory-bridge.ts:235/680). The update uses the service-role `getSupabase()`, never the tool's client.

## Final plan
<!-- plan:begin -->
**Change class:** light. 2 source files, tests, validation docs. No migrations, routes, auth, .github, deploy, governance or LLM-routing files.

**Scope:** services/gateway/src/services/memory/diary.ts, services/gateway/src/services/orb-tools-shared.ts (tool_save_diary_entry only), new tests under services/gateway/test/services/memory/, docs/validation/<VTID>/**.

**Evidence (read-only, production, 2026-10-05):**
- Since 2026-09-23 there are 2 diary_entries rows (2026-09-24, 2026-09-26). Both have source 'voice', and both belong to real members.
- memory_items has 0 rows with source 'diary' created after 2026-09-23. Nothing near either entry's time carries `content_json.diary_entry_id`.
- Cause: the voice tool `tool_save_diary_entry` (orb-tools-shared.ts:4068) writes `diary_entries` directly. It inserts at :4149, and the voice-coalesce path updates at :4138. It never calls `saveDiaryEntry()` (services/memory/diary.ts:145), which is what writes the memory episode (`writeMemoryItemWithIdentity`, source 'diary', `content_json.diary_entry_id`). VTID-04390 moved the app writers; this one was missed.
- The voice tool cannot simply call `saveDiaryEntry()`. That function also runs `syncDiaryToIndex`, while the tool does its own Index recompute with before/after delta math (:4171 onward). Calling both would sync the Index twice.

**Change.**
1. diary.ts: extract the episode write from `saveDiaryEntry()` into an exported `writeDiaryEpisode(identity, { diary_entry_id, text, source, tags, occurred_at })`. It returns the memory_item id or null and never throws. `saveDiaryEntry()` calls it, with byte-identical behaviour.
2. diary.ts: add `updateDiaryEpisodeText(admin, identity, diary_entry_id, text, …)`. It updates the episode's content for that diary row, and writes one if none exists. This serves the voice coalesce path, which appends fragments to the same row. Never throws.
3. tool_save_diary_entry:
   - **Insert path:** `.insert(...).select('id, created_at').single()`.
     - If it returns an error or no row, skip the episode write and log. That is the same non-fatal posture as today: the diary-write flag and the spoken result are unchanged.
     - Otherwise call `writeDiaryEpisode(...)` with the new row's `id` as `diary_entry_id`, its `created_at` as `occurred_at`, source 'voice', and tags ['diary','voice','orb'].
   - **Coalesce path:** after the update succeeds, call `updateDiaryEpisodeText(recentEntry.id, mergedText, …)`.
     - This uses the id of the existing row fetched at :4118-4125. No new row exists in this case.
     - Because it creates the episode if it is missing, a fragment that lands after an earlier failed episode write repairs it.
   - **Client:** `writeMemoryItemWithIdentity` builds its own service-role client (`createMemoryClient()`, orb-memory-bridge.ts:235, called at :680), so the tool's `sb` is irrelevant for the insert. `updateDiaryEpisodeText` uses the same service-role client for its update and select. It never uses the tool's `sb`.
   - **Identity:** the tool's tenant_id, with active_role null (diary is personal memory).
   - **Unchanged:** the Index recompute, the health-feature extraction and the spoken result.
   - If an episode write fails, it logs and the tool result is unchanged. The diary row is the record (plan §8.2).
4. Regression guard test: scan src/ with a multi-line pattern (`from('diary_entries')` followed within the same call chain by `.insert(`, whitespace and newlines allowed). Every file that matches must also reference `writeDiaryEpisode` or `saveDiaryEntry`. The test asserts it finds both known writers, diary.ts and orb-tools-shared.ts, so it cannot pass by matching nothing.
5. Tests:
   - Voice insert writes an episode carrying `diary_entry_id`.
   - Coalesce updates the same episode, and does not create a second one.
   - Episode failure does not change the tool result.
   - `saveDiaryEntry` still writes the same episode as before.

**Data repair (separate owner approval, not part of the code change).** The 2 real members' voice entries from 2026-09-24 and 2026-09-26 have no episode. After deploy, write one episode each with the same shape the fixed code writes: source 'diary', importance 50, category 'notes', `content_json.diary_entry_id`. It is an INSERT into memory_items for those two rows only, run once, with no notification (importance ≤ 50, below `trg_notify_memory_garden`). Embeddings come from the AP-0910 backfill. The repair is idempotent: it skips a row that already has an episode with that `diary_entry_id`, which can happen if a coalesced fragment created one first.

**Risk.** One extra memory write per voice diary entry: the same write a typed entry already makes. The coalesce window means several fragments map to one row and one episode.

**Not in scope:** the six self/disclosed fact pairs (a separate extractor question), AP-0914 scheduling, edge-function deletions.

**Verification.**
- Unit tests and tsc. The voice-insert test fails on the old code.
- STAGING-VERIFY: `/alive` plus jest `existing` entries. A voice diary write cannot be exercised on staging without writing as the test user, which rule 31 forbids, so the behaviour is proven by tests.
- After a real member's next voice diary entry, a read-only SQL check confirms an episode row with that `diary_entry_id`.
<!-- plan:end -->
