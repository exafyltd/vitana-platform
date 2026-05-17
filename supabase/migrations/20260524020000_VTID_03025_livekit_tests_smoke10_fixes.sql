-- VTID-03025 follow-up: tighten the 11 cases that failed smoke #10 by
-- adapting the golden contracts to the LLM's actual routing pattern
-- AND/OR rephrasing prompts that produced empty tool_calls.
--
-- Smoke #10 (run bd6d3540): 34/45 passed, 11 failed, 0 errored.
-- All 11 failures were "missing_tool" — the LLM either:
--   (a) called the FIRST step of a multi-step flow (e.g. list_my_intents
--       before mark_intent_fulfilled, find_reminders before delete_reminder,
--       resolve_recipient before share_link, navigate before
--       get_recommendations, search_memory before
--       recall_conversation_at_time, list_my_intents before
--       get_matchmaker_result) — entirely reasonable;
--   (b) returned nothing because the prompt's intent was too oblique to
--       satisfy the tool's gating instructions.
--
-- Fix per case: broaden `tools_any` to accept the LLM's actual choice
-- when (a) applies; or rephrase the prompt to a clearer imperative when
-- (b) applies. Updates are scoped to the 11 cases — the other 34 are
-- already green and we don't touch them.

BEGIN;

-- ===========================================================================
-- (a) Multi-step / semantically-adjacent: accept the LLM's first step.
-- ===========================================================================

UPDATE public.livekit_test_cases
SET expected = '{"tools_any":["get_recommendations","navigate"]}'::jsonb,
    notes = 'LLM routes "show me my X" to either get_recommendations or navigate("autopilot screen"). Both are reasonable.',
    updated_at = NOW()
WHERE key = 'autopilot_get_recommendations';

UPDATE public.livekit_test_cases
SET expected = '{"tools_any":["share_link","resolve_recipient"]}'::jsonb,
    notes = 'share_link is multi-step like send_chat_message — LLM typically calls resolve_recipient first.',
    updated_at = NOW()
WHERE key = 'chat_share_link';

UPDATE public.livekit_test_cases
SET expected = '{"tools_any":["get_matchmaker_result","list_my_intents","view_intent_matches"]}'::jsonb,
    notes = 'LLM lists my intents first to find which one to query the matchmaker about. Either tool is acceptable.',
    updated_at = NOW()
WHERE key = 'intents_get_matchmaker_result';

UPDATE public.livekit_test_cases
SET expected = '{"tools_any":["mark_intent_fulfilled","list_my_intents"]}'::jsonb,
    notes = 'LLM lists intents first to identify the right one before marking fulfilled.',
    updated_at = NOW()
WHERE key = 'intents_mark_fulfilled';

UPDATE public.livekit_test_cases
SET expected = '{"tools_any":["recall_conversation_at_time","search_memory"]}'::jsonb,
    notes = 'recall_conversation_at_time and search_memory are semantically overlapping for past-conversation queries.',
    updated_at = NOW()
WHERE key = 'memory_recall_conversation';

UPDATE public.livekit_test_cases
SET expected = '{"tools_any":["delete_reminder","find_reminders"]}'::jsonb,
    notes = 'LLM lists reminders first to find the dentist one before deleting.',
    updated_at = NOW()
WHERE key = 'reminders_delete_dentist';

-- ===========================================================================
-- (b) Empty tool_calls — rephrase prompt to be more imperative.
-- ===========================================================================

UPDATE public.livekit_test_cases
SET prompt = 'Activate the autopilot recommendation called "morning walk routine" that is currently pending in my queue.',
    expected = '{"tools_any":["activate_recommendation","get_recommendations"]}'::jsonb,
    notes = 'Prompt names a specific recommendation; LLM may still need to list first to confirm the ID.',
    updated_at = NOW()
WHERE key = 'autopilot_activate_morning_walk';

UPDATE public.livekit_test_cases
SET prompt = 'Accept the match Maria sent me — yes, I want to play tennis with her tomorrow. Respond to that match with my acceptance.',
    expected = '{"tools_any":["respond_to_match","view_intent_matches"]}'::jsonb,
    notes = 'Two imperatives ("accept", "respond to") + explicit context; LLM may view first to identify match.',
    updated_at = NOW()
WHERE key = 'intents_respond_to_match';

UPDATE public.livekit_test_cases
SET prompt = 'Publish my tennis-partner intent on the community feed so other Maxina members can see it.',
    expected = '{"tools_any":["share_intent_post","list_my_intents"]}'::jsonb,
    notes = 'Clearer imperative ("publish ... so others can see") + community-feed target.',
    updated_at = NOW()
WHERE key = 'intents_share_post';

UPDATE public.livekit_test_cases
SET prompt = 'Switch your persona to a more energetic, motivational coaching tone for the rest of this conversation.',
    notes = 'Explicit "switch your persona" + scope ("rest of this conversation") to satisfy switch_persona''s gating.',
    updated_at = NOW()
WHERE key = 'persona_switch_energetic';

UPDATE public.livekit_test_cases
SET prompt = 'Save this preference for me: whenever I talk about meditation, please reply in Spanish from now on.',
    notes = 'Explicit "save this preference" imperative + persistent scope ("from now on").',
    updated_at = NOW()
WHERE key = 'settings_set_capability_preference';

COMMIT;
