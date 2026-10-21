-- BOOTSTRAP-ORB-LATENCY-PHASE1 — voice-pipeline latency retune (version 2 rows).
--
-- Companion to docs/superpowers/plans/2026-06-10-orb-voice-latency-deep-dive.md
-- (PR #2657). The PolicyResolver picks the highest `version` per
-- (policy_key, tenant); these version-2 rows override the Phase D.1 seeds
-- without touching them, so rollback = DELETE the version-2 rows.
--
-- What changes and why:
--   voice.post_turn.cooldown_ms   2000 -> 300
--     The 2 s gate dropped ALL user mic audio after every turn_complete
--     (live-session-controller.ts post_turn_cooldown drop), discarding the
--     user's first words and forcing repeats. The orb widget keeps its own
--     client-side echo gate that starts when playback actually ends, so the
--     long server gate was redundant double protection at ~2 s/turn cost.
--   voice.vad.silence_duration_ms 850 -> 600
--     End-of-speech silence Vertex waits before answering. 600 ms still
--     tolerates natural pauses; saves ~250 ms on every turn.
--
-- Values are BYTE-IDENTICAL to the *_FALLBACK constants in
-- orb/upstream/constants.ts as of this change.
--
-- Idempotent: each INSERT is guarded by WHERE NOT EXISTS against the same
-- (key, tenant, version). Safe to re-run.

INSERT INTO decision_policy (policy_key, tenant_id, version, value_json, source, notes)
SELECT 'voice.post_turn.cooldown_ms', NULL, 2, '300'::jsonb, 'seed',
       'BOOTSTRAP-ORB-LATENCY-PHASE1: 2000->300ms. The 2s post-turn gate dropped the user''s first words after every model turn (latency audit 2026-06-10, PR #2657). Client-side echo gate remains.'
WHERE NOT EXISTS (
  SELECT 1 FROM decision_policy
  WHERE policy_key = 'voice.post_turn.cooldown_ms'
    AND tenant_id IS NULL AND version = 2
);

INSERT INTO decision_policy (policy_key, tenant_id, version, value_json, source, notes)
SELECT 'voice.vad.silence_duration_ms', NULL, 2, '600'::jsonb, 'seed',
       'BOOTSTRAP-ORB-LATENCY-PHASE1: 850->600ms end-of-speech silence; ~250ms saved per turn (latency audit 2026-06-10, PR #2657).'
WHERE NOT EXISTS (
  SELECT 1 FROM decision_policy
  WHERE policy_key = 'voice.vad.silence_duration_ms'
    AND tenant_id IS NULL AND version = 2
);
