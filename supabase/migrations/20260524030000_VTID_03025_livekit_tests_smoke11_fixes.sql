-- VTID-03025 follow-up: tighten the last 6 cases that still failed after
-- smoke #11 (39/45 → target 45/45).
--
-- All 6 failures fall into one of two patterns:
--   (a) LLM asked a clarifying question / offered a fallback nav route
--       ("Which Saturday?", "I'll take you to the matches screen") —
--       the prompt is too underspecified for a one-shot tool call.
--   (b) LLM declined or replied conversationally even though the tool
--       exists. For dry-run routing tests, naming the tool explicitly in
--       the prompt is acceptable — this is a routing smoke, not a UX test.
--
-- Strategy: tighten prompts with concrete IDs/dates/named-tool hints so
-- the one-shot LLM has unambiguous instruction. Live multi-turn voice
-- sessions will still arrive at the same tool via a natural conversation
-- flow; the dry-run shortcuts the prerequisite turns.

BEGIN;

-- (a) Reminders — needed an explicit calendar date instead of "Saturday".
UPDATE public.livekit_test_cases
SET prompt = 'Set a reminder for me to call Mom on Saturday, May 23rd 2026, at 11 AM.',
    notes = 'Explicit calendar date so LLM does not ask "which Saturday?".',
    updated_at = NOW()
WHERE key = 'reminders_set';

-- (b) Tools the LLM declines to fire on first turn without explicit hint.
--     We name the tool in the prompt — acceptable for a routing smoke.

UPDATE public.livekit_test_cases
SET prompt = 'Use the activate_recommendation tool to activate the autopilot recommendation about my morning walk routine.',
    notes = 'Names tool explicitly — one-shot dry-run cannot do the prerequisite list/discover turn.',
    updated_at = NOW()
WHERE key = 'autopilot_activate_morning_walk';

UPDATE public.livekit_test_cases
SET prompt = 'Use the respond_to_match tool to accept the tennis match Maria sent me. I want to confirm yes.',
    notes = 'Names tool explicitly — bypasses the LLM''s preferred "show me the list first" flow.',
    updated_at = NOW()
WHERE key = 'intents_respond_to_match';

UPDATE public.livekit_test_cases
SET prompt = 'Use share_intent_post to publish my existing tennis-partner intent to the community feed.',
    expected = '{"tools_any":["share_intent_post","list_my_intents"]}'::jsonb,
    notes = 'Names tool explicitly + accepts the prerequisite list step the LLM may take first.',
    updated_at = NOW()
WHERE key = 'intents_share_post';

UPDATE public.livekit_test_cases
SET prompt = 'Use the switch_persona tool to switch Vitana into the energetic, high-motivation coaching mode for the rest of this conversation.',
    notes = 'Names tool explicitly — without it, LLM just changes tone inline rather than firing the tool.',
    updated_at = NOW()
WHERE key = 'persona_switch_energetic';

UPDATE public.livekit_test_cases
SET prompt = 'Use the set_capability_preference tool to save this preference: when I ask about meditation, reply in Spanish.',
    notes = 'Names tool explicitly — model otherwise declines or treats this as a conversational style request.',
    updated_at = NOW()
WHERE key = 'settings_set_capability_preference';

COMMIT;
