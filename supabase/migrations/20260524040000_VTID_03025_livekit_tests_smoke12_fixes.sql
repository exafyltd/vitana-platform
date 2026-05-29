-- VTID-03025 follow-up: align the final 5 cases to the ACTUAL semantics
-- of their tools as documented in services/gateway/src/orb/live/tools/
-- live-tool-catalog.ts. Smoke #12 result: 40/45.
--
-- Tool descriptions revealed each LLM hesitation was correct:
--
--   `activate_recommendation` needs a recommendation_id — model refused
--     to invent one.
--   `respond_to_match` needs match_id — same.
--   `share_intent_post` shares a post WITH specified people, not
--     "publish to the feed" (that's a different mental model).
--   `switch_persona` switches to a named colleague (Devon / Sage /
--     Atlas / Mira / Vitana) — NOT a tone variant.
--   `set_capability_preference` sets a default PROVIDER for a
--     capability (e.g. music.play → spotify) — NOT a language preference.
--
-- Prompts updated to match real-world calls that would fire each tool.

BEGIN;

UPDATE public.livekit_test_cases
SET prompt = 'Activate the autopilot recommendation with id "rec_morning_walk_001" right now — call activate_recommendation with that id.',
    notes = 'activate_recommendation needs a recommendation_id; prompt now supplies one.',
    updated_at = NOW()
WHERE key = 'autopilot_activate_morning_walk';

UPDATE public.livekit_test_cases
SET prompt = 'Use respond_to_match to accept match id "match_tennis_maria_001" — my response is "yes, see you tomorrow".',
    notes = 'respond_to_match needs a match_id; prompt now supplies one + response text.',
    updated_at = NOW()
WHERE key = 'intents_respond_to_match';

UPDATE public.livekit_test_cases
SET prompt = 'Share my tennis-partner intent post with my friend Maria — call share_intent_post and send it to @maria6.',
    expected = '{"tools_any":["share_intent_post","list_my_intents","resolve_recipient"]}'::jsonb,
    notes = 'share_intent_post sends a post WITH specified recipients (not "publish to feed"). LLM may resolve_recipient first.',
    updated_at = NOW()
WHERE key = 'intents_share_post';

UPDATE public.livekit_test_cases
SET label = 'Switch persona to Sage',
    prompt = 'Switch the active persona to Sage — I want to talk to Sage about a community-support question.',
    notes = 'switch_persona switches to a named colleague (Sage / Devon / Atlas / Mira / Vitana), NOT a tone variant. Sage is the support persona per the spec.',
    updated_at = NOW()
WHERE key = 'persona_switch_energetic';

UPDATE public.livekit_test_cases
SET label = 'Make Spotify the default music provider',
    prompt = 'Make Spotify my default music provider from now on — always play music on Spotify.',
    notes = 'set_capability_preference sets default PROVIDER for a capability (music.play → spotify). NOT a language preference.',
    updated_at = NOW()
WHERE key = 'settings_set_capability_preference';

COMMIT;
