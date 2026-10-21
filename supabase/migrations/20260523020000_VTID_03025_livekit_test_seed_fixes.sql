-- VTID-03025 follow-up: fix two seed cases that failed smoke #6 for
-- reasons unrelated to the framework — pure golden-contract drift.
--
-- diary_coffee_water:
--   Used `args_match.entry` (no such arg on save_diary_entry). The actual
--   parameter is `raw_text` per the live tool catalog
--   (services/gateway/src/orb/live/tools/live-tool-catalog.ts).
--
-- tech_support_devon:
--   The `report_to_specialist` tool description requires the LLM to
--   PROPOSE the handoff first and wait for explicit user consent before
--   calling. In a one-shot eval the LLM correctly refuses to fire on the
--   "first message" — even when the user says "Connect me to Devon",
--   that counts as the user's first turn, not a confirmation of the
--   LLM's prior proposal. Rewriting the prompt as if the user has
--   already affirmed an earlier proposal satisfies the gate.

BEGIN;

UPDATE public.livekit_test_cases
SET
  prompt = 'Add to my daily diary: I just had one coffee and a big glass of water about 500ml.',
  expected = '{"tools":["save_diary_entry"],"args_match":{"save_diary_entry":{"raw_text":{"type":"regex","pattern":"(?i)(coffee|water|500)"}}}}'::jsonb,
  notes = 'save_diary_entry passes the user verbatim as raw_text (not entry). Args regex matches coffee/water/500 in the raw_text.',
  updated_at = NOW()
WHERE key = 'diary_coffee_water';

UPDATE public.livekit_test_cases
SET
  prompt = 'Yes, please bring in Devon to file this. The bug: the diary save button on mobile is broken — I tap save and the entry vanishes instead of being recorded. I want to report this to support.',
  notes = 'report_to_specialist enforces propose-first consent. Prompt is phrased as the user confirming an earlier proposal ("Yes, please bring in Devon to file this") plus concrete bug + screen so the >=15-word summary requirement is satisfiable.',
  updated_at = NOW()
WHERE key = 'tech_support_devon';

COMMIT;
