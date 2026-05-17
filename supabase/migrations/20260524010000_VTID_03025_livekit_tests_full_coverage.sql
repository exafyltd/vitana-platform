-- VTID-03025: expand the LiveKit hourly test grid to cover ALL currently-live
-- tools in `tool-manifest.json` (50 live as of 2026-05-17).
--
-- The original 13-case seed (migration 20260522000001) covered 18 distinct
-- live tools. This migration adds 32 new cases — one per remaining live
-- tool — so the suite has parity with the catalog. Future tools (147 total
-- in manifest, 50 currently live) will be flagged by the new coverage
-- endpoint (`/api/v1/voice-lab/tests/coverage`) until cases are added.

BEGIN;

INSERT INTO public.livekit_test_cases (key, label, prompt, expected, notes) VALUES

-- ============================================================================
-- Calendar (2 new)
-- ============================================================================
('search_calendar_next_tuesday',
 'Search calendar — next Tuesday',
 'Do I have anything scheduled for next Tuesday?',
 '{"tools":["search_calendar"]}'::jsonb,
 'Calendar lookup for a specific day.'),

('get_schedule_today',
 'Get today''s schedule',
 'What''s on my agenda for today?',
 '{"tools_any":["get_schedule","search_calendar"]}'::jsonb,
 'Today/agenda query — either get_schedule or search_calendar may fire.'),

-- ============================================================================
-- Autopilot (2 new)
-- ============================================================================
('autopilot_get_recommendations',
 'List autopilot recommendations',
 'Show me my autopilot recommendations.',
 '{"tools":["get_recommendations"]}'::jsonb,
 'Read-only fetch of pending autopilot recs.'),

('autopilot_activate_morning_walk',
 'Activate an autopilot recommendation',
 'Activate the recommendation about taking a morning walk.',
 '{"tools":["activate_recommendation"]}'::jsonb,
 'Activation requires the LLM to ID and act on the relevant rec.'),

-- ============================================================================
-- Health logging + index (6 new)
-- ============================================================================
('health_index_improvement_plan',
 'Create Vitana Index improvement plan',
 'Create a 30-day plan to improve my Vitana Index, focusing on my weakest pillar.',
 '{"tools":["create_index_improvement_plan"]}'::jsonb,
 'Multi-step planning tool — explicit "create a plan" wording.'),

('health_ask_pillar_agent_sleep',
 'Ask Sleep pillar agent',
 'Ask my Sleep pillar agent what trends it sees in my sleep this past week.',
 '{"tools":["ask_pillar_agent"]}'::jsonb,
 'Pillar-specific delegation prompt.'),

('health_get_pillar_subscores',
 'Get pillar subscores',
 'Show me my detailed Sleep pillar subscores.',
 '{"tools":["get_pillar_subscores"]}'::jsonb,
 'Lower-level breakdown of a single pillar.'),

('health_log_water',
 'Log water intake',
 'I just drank a big glass of water, about 500ml.',
 '{"tools_any":["log_water","save_diary_entry"]}'::jsonb,
 'log_water is the explicit tool; save_diary_entry also handles water as the extractor catches "500ml". tools_any keeps the contract honest about either route.'),

('health_log_sleep',
 'Log sleep',
 'Last night I slept seven and a half hours, woke up at 6:30 AM feeling rested.',
 '{"tools_any":["log_sleep","save_diary_entry"]}'::jsonb,
 'log_sleep direct, or save_diary_entry which forwards to the extractor.'),

('health_log_exercise',
 'Log exercise',
 'I just finished a 30 minute run in the park.',
 '{"tools_any":["log_exercise","save_diary_entry"]}'::jsonb,
 'Exercise logging.'),

('health_log_meditation',
 'Log meditation',
 'I just finished a 10 minute meditation session, feeling calm.',
 '{"tools_any":["log_meditation","save_diary_entry"]}'::jsonb,
 'Meditation logging.'),

-- ============================================================================
-- Reminders (3 new)
-- ============================================================================
('reminders_set',
 'Set a reminder',
 'Remind me to call Mom on Saturday at 11 AM.',
 '{"tools":["set_reminder"]}'::jsonb,
 'Standard reminder set.'),

('reminders_find',
 'Find this week''s reminders',
 'What reminders do I have for this week?',
 '{"tools":["find_reminders"]}'::jsonb,
 'Read-only reminder lookup.'),

('reminders_delete_dentist',
 'Delete a reminder',
 'Delete my reminder about the dentist appointment.',
 '{"tools":["delete_reminder"]}'::jsonb,
 'Deletion by topic — LLM must identify the right reminder.'),

-- ============================================================================
-- Intents / matchmaking (5 new)
-- ============================================================================
('intents_list_my',
 'List my intents',
 'What intents have I posted recently?',
 '{"tools":["list_my_intents"]}'::jsonb,
 'Read-only intent list.'),

('intents_get_matchmaker_result',
 'Get matchmaker result',
 'Show me the matchmaker result for my tennis partner search.',
 '{"tools":["get_matchmaker_result"]}'::jsonb,
 'Matchmaker output lookup.'),

('intents_mark_fulfilled',
 'Mark intent fulfilled',
 'Mark my tennis partner intent as fulfilled — I found someone.',
 '{"tools":["mark_intent_fulfilled"]}'::jsonb,
 'State transition on an existing intent.'),

('intents_share_post',
 'Share an intent post',
 'Share my tennis partner intent on the community feed.',
 '{"tools":["share_intent_post"]}'::jsonb,
 'Cross-surface share action.'),

('intents_respond_to_match',
 'Respond to a match',
 'Accept the match Maria sent me for tennis.',
 '{"tools":["respond_to_match"]}'::jsonb,
 'Affirmative response to an incoming match.'),

-- ============================================================================
-- Memory (2 new)
-- ============================================================================
('memory_search_routine',
 'Search memory for past routine',
 'What did I tell you about my work routine last week?',
 '{"tools":["search_memory"]}'::jsonb,
 'Memory recall — distinct from search_knowledge (personal-history trigger).'),

('memory_recall_conversation',
 'Recall conversation at a time',
 'What did we talk about yesterday evening around 8 PM?',
 '{"tools":["recall_conversation_at_time"]}'::jsonb,
 'Time-anchored conversation recall.'),

-- ============================================================================
-- Persona / Specialist (1 new — report_to_specialist already covered)
-- ============================================================================
('persona_switch_energetic',
 'Switch persona to energetic',
 'Switch to a more energetic coaching tone for the next few minutes.',
 '{"tools":["switch_persona"]}'::jsonb,
 'Within-Vitana style switch — NOT specialist handoff (that''s report_to_specialist).'),

-- ============================================================================
-- Community (1 new)
-- ============================================================================
('community_find_member',
 'Find a community member',
 'Find a community member named Anna who lives in Berlin.',
 '{"tools":["find_community_member"]}'::jsonb,
 'Community-member directory search.'),

-- ============================================================================
-- Settings (1 new)
-- ============================================================================
('settings_set_capability_preference',
 'Set a capability preference',
 'When I''m talking about meditation, always respond to me in Spanish.',
 '{"tools":["set_capability_preference"]}'::jsonb,
 'Persistent user-preference write.'),

-- ============================================================================
-- Email (1 new)
-- ============================================================================
('email_read_latest',
 'Read latest email',
 'Read me my latest email.',
 '{"tools":["read_email"]}'::jsonb,
 'Connected-provider email read.'),

-- ============================================================================
-- Contacts (1 new)
-- ============================================================================
('contacts_find_sarah',
 'Find a contact by name',
 'What''s Sarah''s phone number?',
 '{"tools":["find_contact"]}'::jsonb,
 'Contact lookup by name.'),

-- ============================================================================
-- External AI (1 new)
-- ============================================================================
('ai_consult_external_claude',
 'Consult external AI',
 'Ask Claude to help me draft a polite email declining a meeting invitation.',
 '{"tools":["consult_external_ai"]}'::jsonb,
 'Forward to user-connected ChatGPT/Claude/Gemini account.'),

-- ============================================================================
-- Help (1 new)
-- ============================================================================
('help_explain_autopilot',
 'Explain a feature',
 'How does the Autopilot feature work, and what does it do for me?',
 '{"tools_any":["explain_feature","search_knowledge"]}'::jsonb,
 'Feature explanation may route via search_knowledge or explain_feature.'),

-- ============================================================================
-- Chat (1 new — send_chat_message + resolve_recipient already covered)
-- ============================================================================
('chat_share_link',
 'Share a link',
 'Share this article link with Maria: https://example.com/longevity-tips',
 '{"tools":["share_link"]}'::jsonb,
 'Link-share to another user.'),

-- ============================================================================
-- Navigation (1 new — navigate + navigate_to_screen already covered)
-- ============================================================================
('nav_get_current_screen',
 'What screen am I on',
 'What screen am I on right now?',
 '{"tools":["get_current_screen"]}'::jsonb,
 'Current-route lookup.'),

-- ============================================================================
-- Marketplace (2 new, vertex-only — may not fire in LiveKit path)
-- ============================================================================
('marketplace_find_product_vitamin_d',
 'Find a product',
 'Help me find a good vitamin D supplement.',
 '{"tools":["find_perfect_product"]}'::jsonb,
 'Vertex-only tool. May fail in LiveKit path until parity is reached.'),

('marketplace_find_practitioner_berlin',
 'Find a practitioner',
 'Find me a meditation coach in Berlin.',
 '{"tools":["find_perfect_practitioner"]}'::jsonb,
 'Vertex-only tool. May fail in LiveKit path until parity is reached.');

COMMIT;
