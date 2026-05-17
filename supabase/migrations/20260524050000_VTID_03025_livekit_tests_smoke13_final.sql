-- VTID-03025 follow-up: last case. respond_to_match enum requires
-- "express_interest" or "decline" — my prompt said "accept" which is
-- neither. LLM correctly refused to invent a value.

BEGIN;

UPDATE public.livekit_test_cases
SET prompt = 'Use respond_to_match to express interest in match id "match_tennis_maria_001" — my response choice is express_interest.',
    notes = 'respond_to_match needs match_id + response enum (express_interest|decline). "accept" is not a valid value.',
    updated_at = NOW()
WHERE key = 'intents_respond_to_match';

COMMIT;
