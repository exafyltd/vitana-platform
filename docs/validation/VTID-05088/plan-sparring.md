# VTID-05088 — plan sparring record

- Plan hash (sha256 of the text between the plan markers): `15483e2ec621c6465bef59429f131da7ca4aa200aeea2a025100c2fa6e7231e8`
- Change class: standard. Partner: plan-sparring-partner (independent, read-only). Rounds: 2.
- Verdict: **converged**. Round 1: F1 major (fragment-length signal unreliable) — accepted in a different form; the partner's suggested transcript_turns signal was rejected as circular and the partner verified the rejection. F2 accepted, F3 kept with a reason, F4 acknowledged. Round 2: all closed; F5/F6 minors accepted as SQL comments.
- Owner approval: "Yes" in the Claude Code session, 2026-10-12, after the Gate 1 message. Allocated after approval.

## Final plan, every round's findings and the planner's responses

# Plan — morning check row 21: tell "nobody spoke" apart from "memory is broken"

<!-- plan:begin -->
## Problem (verified read-only, 2026-10-12)
MORNING-SYSTEM-HEALTH-CHECK.yml failed 2/22 on 2026-10-11 (run 38138854395):
row 21 (memory) and row 22 (self-audit, only because row 21 failed — all 11
watched workflows were green). Row 21 fails on `WRITES == 0`
(`facts_written_24h + items_written_24h` from `ci_memory_health()`,
`supabase/migrations/20260923140000_vtid_04345_ci_memory_health.sql`).

Root cause of the zero, from production data:
- The write path works whenever someone speaks: the last member voice
  conversation (2026-10-08 17:16, 14 turns) produced 15 `orb_voice`
  memory_items and transcript turns. `memory_transcript_turns` and
  `memory_items(source=orb_voice)` both stop at 2026-10-08 17:17 — the end of
  that conversation.
- Nobody spoke afterwards. `orb.live.diag stage=input_transcription`
  (emitted for every user speech fragment,
  `orb/live/session/upstream-message-handler.ts:1344` and `:1876`, not
  sampled) has 1 fragment since 2026-10-08 17:18 ("ja", 2 chars). Member
  sessions since Oct 9 are greeting-only or closed by the member within
  seconds (`orb.session.continuity.persisted hide_reason=close_button`, median
  3.9 s after tap); 0 member sessions with user audio Oct 9–11.
- Reads are healthy (155/155 prompts carried memory, coverage 96%, AP-0910 ran
  11:53 today, DLQ 0).
So the check conflates "no conversation happened" with "the memory pipeline is
broken" and goes red on every quiet day. It also did not exist as a problem
before 2026-10-01 only because an automated test-account harness produced
hundreds of voice sessions a day on production; that traffic has stopped.

## Change
1. New migration `supabase/migrations/<ts>_vtid_<n>_ci_memory_health_speech_input.sql`:
   `CREATE OR REPLACE FUNCTION public.ci_memory_health()` with the same
   signature, SECURITY DEFINER, search_path and service_role-only grant as the
   VTID-04345 version, every existing key unchanged, plus two new keys:
   - `user_speech_turns_24h`: number of user turns in the last 24h whose
     transcribed text, summed over that turn's fragments, is longer than 20
     characters. Source: `oasis_events` `topic='orb.live.diag'`,
     `metadata->>'stage'='input_transcription'`, grouped by
     (`metadata->>'session_id'`, `metadata->>'turn_count'`),
     `sum(char_length(metadata->>'text_preview')) > 20`. Nova Sonic sends
     delta fragments that are appended to `session.inputTranscriptBuffer`
     (upstream-message-handler.ts:1880) and the write gate is on that whole
     buffer (`userText.length > 20`, :744 / :2736), so the per-turn sum is the
     matching quantity; a single fragment's length is not. Every diag carries
     `turn_count` (routes/orb-live.ts:15847). This signal is independent of the
     memory writer: it is emitted in the upstream handler before the buffer is
     flushed, so it stays positive if the path to the writer breaks.
     SQL comments record two accepted approximations: inter-fragment spaces
     are not counted (a borderline turn may be missed — the safe direction),
     and Vertex (sr/ru) fragments may be cumulative, which overcounts (also
     safe: such a turn always reads as speech).
   - `transcript_turns_24h`: count of `memory_transcript_turns` with
     `created_at > now()-24h` (recorded for every user turn before the
     trivial-message filter, orb-memory-bridge.ts:652–666).
2. `MORNING-SYSTEM-HEALTH-CHECK.yml` row 21 only:
   - `no-memory-writes-24h` now fails only when `user_speech_turns_24h > 0`
     (someone spoke and nothing was written).
   - NEW failure: `speech-not-recorded` when `user_speech_turns_24h > 0`
     and `transcript_turns_24h == 0` (spoken turns never reached the writer).
   - When `user_speech_turns_24h == 0` and writes are 0, row 21 PASSes on
     that point and the detail says `no user speech in 24h (nothing to
     remember)`. Every other row-21 condition (memory-never-reached-prompt,
     coverage < 90, DLQ > 0, AP-0910 > 3h, language churn > 25) is unchanged
     and still fails the row on its own.
   - Older RPC (keys missing → jq `// 0`): speech counts read 0, so an old
     function would PASS the writes condition — therefore the migration is
     applied BEFORE the workflow change takes effect (step 5), and the row also
     prints the two new numbers so a missing key is visible.
3. Test `services/gateway/test/vtid-<n>-memory-health-speech-input.test.ts`:
   migration contract (new keys, old keys unchanged, security/grant kept) and
   the row-21 shell logic extracted from the workflow and run for the cases:
   quiet day → PASS; speech + writes → PASS; speech + 0 writes → FAIL
   no-memory-writes; speech + 0 transcript turns → FAIL speech-not-recorded;
   coverage 80 on a quiet day → still FAIL.
4. `DATABASE_SCHEMA.md` (change-log row + ci_memory_health entry updated),
   evidence dir `docs/validation/VTID-<n>/`.
5. After merge: apply the migration with `RUN-MIGRATION.yml`; verify read-only
   (RPC returns the new keys); dispatch `MORNING-SYSTEM-HEALTH-CHECK.yml` once
   (read-only checks) and confirm row 21 and 22 PASS; local Postgres harness
   before merge for the SQL.

## Not in scope
- AP-0910 age: it runs on the dedicated 30-minute production loop independent of traffic (memory-embedding-backfill-loop.ts; `ap0910_last_run` 2026-10-12 11:53), so a quiet day does not age it; unchanged.
- Voice usage itself (members closing the overlay within seconds). That is a
  product signal, not a defect found here; no code change proposed for it.
- The other row-21 thresholds.

## Change class
standard (migration + workflow). Files: 1 migration, the morning workflow
(row 21 step only), 1 test, DATABASE_SCHEMA.md, evidence docs.
<!-- plan:end -->

## Planner responses — round 1
- F1 [major] ACCEPTED in a different form. The fragment-length filter is wrong (fragments are deltas; the gate is on the whole turn buffer). REJECTED using `transcript_turns_24h` as the "someone spoke" signal: it is written inside writeMemoryItemWithIdentity (orb-memory-bridge.ts:655), so if the path from the upstream handler to the writer breaks, transcript turns AND writes are both 0 and the check would PASS on exactly the failure it exists to catch (circular). Replaced by `user_speech_turns_24h`: per-(session, turn_count) summed fragment chars > 20, which mirrors the buffer gate and is emitted upstream of the writer.
- F2 [minor] ACCEPTED. Text corrected; no claim that fragment length matches the buffer gate.
- F3 [minor] REJECTED (kept). With an independent speech signal, `speech-not-recorded` (speech turns > 0, transcript turns 0) is the detector for "turns never reached the writer" — e.g. the call sites at :744/:2736 gated off, identity missing. `no-memory-writes-24h` alone would also fire there but could not say where it broke; transcript_turns > 0 with writes 0 points at the item/fact write instead. Two distinct diagnoses, cheap.
- F4 [minor] ACKNOWLEDGED, no change: AP-0910 runs on a 30-min loop independent of traffic (last run today 11:53); noted under Not in scope.
- Q1: no — see F1 (circular). Q2: the RPC exposes user_speech_turns_24h and transcript_turns_24h; both are printed in the row detail.

## Partner round 2 (verbatim verdict): CONVERGED. F1 closed, F2 closed, F3 acknowledged, F4 closed. New: F5 [minor] summed fragments undercount by inter-fragment spaces; F6 [minor] Vertex cumulative fragments overcount — both err in the safe direction; suggestion: comment in the SQL.

## Planner responses — round 2
- F5 [minor] ACCEPTED: SQL comment added to the plan.
- F6 [minor] ACCEPTED: SQL comment added to the plan.
