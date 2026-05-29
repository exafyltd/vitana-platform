-- VTID-03025: LiveKit hourly tests — foundation (Slice 1a)
--
-- Adds three tables backing the hourly Layer-A dry-run test suite that
-- evaluates the LiveKit voice agent's tool-routing behavior against
-- golden contracts. No tool execution happens — the runner only inspects
-- which tool Gemini chose given the same system instruction + tool
-- catalog the live agent sees.
--
-- See: services/gateway/src/services/voice-lab/livekit-test-{eval,scorer,runner}.ts

BEGIN;

-- ============================================================================
-- livekit_test_cases — golden contracts. Seeded with 13 cases; tweakable
-- via direct SQL or a future admin route. The expected JSONB drives the
-- scorer (see livekit-test-scorer.ts).
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.livekit_test_cases (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key         TEXT NOT NULL UNIQUE,
  label       TEXT NOT NULL,
  prompt      TEXT NOT NULL,
  expected    JSONB NOT NULL,
  layer       TEXT NOT NULL DEFAULT 'A' CHECK (layer IN ('A','B')),
  enabled     BOOLEAN NOT NULL DEFAULT TRUE,
  notes       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS livekit_test_cases_enabled_idx
  ON public.livekit_test_cases (enabled);
CREATE INDEX IF NOT EXISTS livekit_test_cases_layer_idx
  ON public.livekit_test_cases (layer);

COMMENT ON COLUMN public.livekit_test_cases.expected IS
  'Golden contract. Keys: tools (all required), tools_any (any one required), forbidden_tools (none allowed), args_match (per-tool arg matchers: regex|exact|enum|non_empty), intent (free_text to assert zero tool calls). See livekit-test-scorer.ts for full schema.';

-- ============================================================================
-- livekit_test_runs — one row per scheduled or ad-hoc run.
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.livekit_test_runs (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at  TIMESTAMPTZ,
  layer        TEXT NOT NULL DEFAULT 'A' CHECK (layer IN ('A','B')),
  trigger      TEXT NOT NULL DEFAULT 'manual'
                 CHECK (trigger IN ('manual','cron','admin','test')),
  total        INT NOT NULL DEFAULT 0,
  passed       INT NOT NULL DEFAULT 0,
  failed       INT NOT NULL DEFAULT 0,
  errored      INT NOT NULL DEFAULT 0,
  duration_ms  INT,
  meta         JSONB
);

CREATE INDEX IF NOT EXISTS livekit_test_runs_started_at_idx
  ON public.livekit_test_runs (started_at DESC);
CREATE INDEX IF NOT EXISTS livekit_test_runs_trigger_idx
  ON public.livekit_test_runs (trigger);

-- ============================================================================
-- livekit_test_results — one row per case per run.
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.livekit_test_results (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id             UUID NOT NULL REFERENCES public.livekit_test_runs(id) ON DELETE CASCADE,
  case_id            UUID NOT NULL REFERENCES public.livekit_test_cases(id) ON DELETE CASCADE,
  case_key           TEXT NOT NULL,
  status             TEXT NOT NULL CHECK (status IN ('passed','failed','errored')),
  tool_calls         JSONB,
  reply_text         TEXT,
  expected           JSONB NOT NULL,
  failure_reasons    TEXT[],
  error              TEXT,
  latency_ms         INT,
  instruction_chars  INT,
  retried            BOOLEAN NOT NULL DEFAULT FALSE,
  started_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at        TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS livekit_test_results_run_id_idx
  ON public.livekit_test_results (run_id);
CREATE INDEX IF NOT EXISTS livekit_test_results_case_started_idx
  ON public.livekit_test_results (case_id, started_at DESC);
CREATE INDEX IF NOT EXISTS livekit_test_results_status_idx
  ON public.livekit_test_results (status);

COMMENT ON COLUMN public.livekit_test_results.failure_reasons IS
  'Structured reasons (e.g. "missing_tool:save_diary_entry", "args_mismatch:save_diary_entry.entry:non_empty"). See livekit-test-scorer.ts.';

-- ============================================================================
-- Seed: the original 13 cases.
--
-- Each case mirrors a real user utterance. Prompts are kept close to the
-- user's verbatim phrasing — the test surface reflects production language,
-- not gamed-for-LLM strings. Where a prompt would otherwise trip the
-- propose-first / multi-step gates in the live system instruction, the
-- prompt is minimally extended to encode the consent the user would have
-- already given in a real conversation.
-- ============================================================================
INSERT INTO public.livekit_test_cases (key, label, prompt, expected, notes) VALUES
('tech_support_devon',
 'Tech support → Devon handoff',
 'Connect me to Devon — I have a bug to report. The diary save button is broken on mobile and the entry is lost when I tap it.',
 '{"tools":["report_to_specialist"],"args_match":{"report_to_specialist":{"specialist_hint":{"type":"regex","pattern":"(?i)devon"},"summary":{"type":"non_empty"}}}}'::jsonb,
 'Tests report_to_specialist routing. Prompt includes consent + concrete bug so the propose-first gate is satisfied.'),

('send_message_maria',
 'Send chat message to Maria Maksina',
 'Send a message to Maria Maksina with user id maria6 saying I will be a few minutes late.',
 '{"tools_any":["send_chat_message","resolve_recipient"],"args_match":{"send_chat_message":{"message":{"type":"non_empty"}}}}'::jsonb,
 'Multi-step flow: model may call resolve_recipient first or send_chat_message directly. tools_any accepts either.'),

('diary_coffee_water',
 'Add diary entry: coffee + water',
 'Add to my daily diary: I just had one coffee and a big glass of water about 500ml.',
 '{"tools":["save_diary_entry"],"args_match":{"save_diary_entry":{"entry":{"type":"regex","pattern":"(?i)(coffee|water|500)"}}}}'::jsonb,
 'save_diary_entry triggers Vitana Index recompute. Args check looks for coffee/water/500 in the entry text.'),

('life_compass_query',
 'What is my life compass',
 'What is my life compass?',
 '{"tools":["get_life_compass"]}'::jsonb,
 'Read-only Life Compass fetch.'),

('web_search_maria_news',
 'Web search Maria Maksina news',
 'Check the news on the web about what is new with Maria Maksina and her show performance yesterday.',
 '{"tools":["search_web"],"args_match":{"search_web":{"query":{"type":"regex","pattern":"(?i)maria"}}}}'::jsonb,
 'Web search routing. Query must mention Maria.'),

('vitana_drop_explanation',
 'Why did my Vitana drop, explain',
 'Why did my Vitana drop since yesterday? Explain the reason.',
 '{"tools_any":["get_vitana_index","get_index_improvement_suggestions"]}'::jsonb,
 'Could route to either tool. Both are read-only Vitana Index introspection. tools_any accepts either.'),

('maxina_community_query',
 'What is the Maxina community',
 'What is the Maxina community?',
 '{"tools_any":["search_community","search_knowledge"]}'::jsonb,
 'Knowledge-or-community lookup. Either is acceptable.'),

('maxina_event_july_mallorca',
 'First Maxina event July 2026 in Mallorca',
 'Which Maxina experience event is the first event in July 2026 in Mallorca?',
 '{"tools":["search_events"],"args_match":{"search_events":{}}}'::jsonb,
 'Event search. Args left unconstrained for v1 — args structure varies by date encoding.'),

('tennis_partner_mallorca',
 'Find tennis partner in Mallorca this week',
 'I am looking for a partner to play tennis with this coming week in Mallorca.',
 '{"tools_any":["post_intent","scan_existing_matches","view_intent_matches"]}'::jsonb,
 'Matchmaker entry point — model may post a new intent or scan existing matches first.'),

('play_song_youtube',
 'Play All at Once by Whitney Houston on YouTube Music',
 'Play the song "All at Once" by Whitney Houston on YouTube Music.',
 '{"tools":["play_music"],"args_match":{"play_music":{}}}'::jsonb,
 'Music playback routing. Args unconstrained — title/artist/source layout varies.'),

('calendar_jovana_tomorrow',
 'Calendar event: call Jovana tomorrow at 15:00',
 'Add to my calendar a meeting tomorrow at 15:00 to call Jovana.',
 '{"tools_any":["create_calendar_event","add_to_calendar"],"args_match":{"create_calendar_event":{"title":{"type":"regex","pattern":"(?i)jovana"}},"add_to_calendar":{"title":{"type":"regex","pattern":"(?i)jovana"}}}}'::jsonb,
 'Calendar create. Either canonical tool acceptable; args check requires Jovana in the title when matched.'),

('location_time_query',
 'What is my location and the time at my location',
 'What is my location and the time at my location?',
 '{"intent":"free_text"}'::jsonb,
 'User timezone + location land in bootstrap_context already — the model should answer inline without a tool call.'),

('triple_navigate',
 'Open wallet, My Journey, podcasts',
 'Open my wallet. Then open My Journey. Then open the screen with podcasts.',
 '{"tools_any":["navigate","navigate_to_screen"]}'::jsonb,
 'Triple navigation. Slice 1a only requires at least one navigate call — multi-tool capture comes in a later slice.');

COMMIT;
