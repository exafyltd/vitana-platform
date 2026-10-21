-- VTID-04776: Voice Supervisor P0 data foundation — one row per voice session.
--
-- Until now a voice session existed only as a scatter of OASIS events
-- (vtid.live.session.start / stop, orb.session.profile.resolved,
-- orb.upstream.provider.selected, voice.latency.measured, orb.live.diag),
-- none of which carry a tenant column and several of which carry no role,
-- surface, language or provider. Answering "is voice broken for everyone or
-- for one tenant / assistant / provider / language?" meant joining those
-- events in the browser. This table is the per-session fact the Voice
-- Supervisor reads.
--
-- Writer: the gateway only (services/gateway/src/services/voice-session-facts.ts),
-- fire-and-forget upserts keyed on session_id from the ORB start path, the
-- profile/provider/first-audio updates, every gateway stop path, the LiveKit
-- token mint and the orb-agent's session start/stop (via /api/v1/oasis/emit).
-- Kill switch: VOICE_SESSION_FACTS_ENABLED=false.
--
-- Reader: /api/v1/voice/supervisor/* (service role). RLS is on with no
-- policies, so no client JWT can read a row; anon/authenticated are revoked.
--
-- voice_session_facts_backfill(p_since) rebuilds rows from oasis_events. It
-- is NOT run by this migration — it is an operator action after apply:
--   SELECT public.voice_session_facts_backfill(now() - interval '7 days');
--
-- Additive only; no existing table, view or function is touched. Idempotent.

CREATE TABLE IF NOT EXISTS public.voice_session_facts (
    session_id          TEXT PRIMARY KEY,
    tenant_id           UUID NULL,
    user_id             UUID NULL,
    is_anonymous        BOOLEAN NOT NULL DEFAULT false,
    surface             TEXT NULL,          -- vitanaland | command-hub | admin | backoffice | commerce
    role                TEXT NULL,          -- the role this Vitana served (resolved Assistant Profile role)
    persona_key         TEXT NULL,
    profile_resolution  TEXT NULL,          -- declared | route | narrowed | unverified | anonymous
    lang                TEXT NULL,
    provider            TEXT NULL CHECK (provider IS NULL OR provider IN ('nova_sonic','cascade','vertex_serbian_bridge','livekit','unknown')),
    selection_reason    TEXT NULL,
    transport           TEXT NULL CHECK (transport IS NULL OR transport IN ('sse','ws','livekit')),
    is_mobile           BOOLEAN NULL,
    app_version         TEXT NULL,
    entry               TEXT NULL,
    started_at          TIMESTAMPTZ NOT NULL,
    ended_at            TIMESTAMPTZ NULL,
    last_activity_at    TIMESTAMPTZ NULL,
    duration_ms         INTEGER NULL,
    turn_count          INTEGER NULL,
    user_turns          INTEGER NULL,
    model_turns         INTEGER NULL,
    audio_in_chunks     INTEGER NULL,
    audio_out_chunks    INTEGER NULL,
    ttfa_ms             INTEGER NULL,       -- time to first audio (session start -> first model audio out)
    p50_turn_ms         INTEGER NULL,
    close_reason        TEXT NULL,
    close_code          INTEGER NULL,       -- last upstream close code seen before the end
    failure_class       TEXT NULL,          -- voice-failure-taxonomy class (voice.*), NULL when healthy
    outcome             TEXT NULL CHECK (outcome IS NULL OR outcome IN ('ok','silent','one_way','dropped','error','abandoned','active')),
    stall_count         INTEGER NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.voice_session_facts IS
  'VTID-04776: one row per ORB voice session (SSE, WS, LiveKit). Written by the gateway (fire-and-forget upserts on session_id), read by /api/v1/voice/supervisor. Service role only.';

CREATE INDEX IF NOT EXISTS idx_voice_session_facts_started
    ON public.voice_session_facts (started_at DESC);
CREATE INDEX IF NOT EXISTS idx_voice_session_facts_tenant_started
    ON public.voice_session_facts (tenant_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_voice_session_facts_surface_role_started
    ON public.voice_session_facts (surface, role, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_voice_session_facts_provider_started
    ON public.voice_session_facts (provider, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_voice_session_facts_lang_started
    ON public.voice_session_facts (lang, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_voice_session_facts_open
    ON public.voice_session_facts (started_at DESC) WHERE ended_at IS NULL;

-- updated_at maintenance.
CREATE OR REPLACE FUNCTION public.voice_session_facts_touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS trg_voice_session_facts_touch ON public.voice_session_facts;
CREATE TRIGGER trg_voice_session_facts_touch
    BEFORE UPDATE ON public.voice_session_facts
    FOR EACH ROW EXECUTE FUNCTION public.voice_session_facts_touch_updated_at();

ALTER TABLE public.voice_session_facts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.voice_session_facts FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.voice_session_facts TO service_role;

-- Hourly rollup. security_invoker so the view runs with the CALLER's rights
-- (a definer view would bypass the table's RLS); anon/authenticated revoked.
CREATE OR REPLACE VIEW public.voice_session_facts_hourly
WITH (security_invoker = true) AS
SELECT
    date_trunc('hour', f.started_at)                                    AS bucket,
    f.tenant_id,
    f.surface,
    f.role,
    f.provider,
    f.lang,
    count(*)::int                                                       AS sessions,
    count(*) FILTER (WHERE f.outcome = 'ok')::int                       AS ok,
    count(*) FILTER (WHERE f.outcome = 'silent')::int                   AS silent,
    count(*) FILTER (WHERE f.outcome = 'one_way')::int                  AS one_way,
    count(*) FILTER (WHERE f.outcome = 'dropped')::int                  AS dropped,
    count(*) FILTER (WHERE f.outcome = 'error')::int                    AS error,
    avg(f.duration_ms)::int                                             AS avg_duration_ms,
    (percentile_cont(0.5)  WITHIN GROUP (ORDER BY f.ttfa_ms))::int      AS p50_ttfa_ms,
    (percentile_cont(0.95) WITHIN GROUP (ORDER BY f.ttfa_ms))::int      AS p95_ttfa_ms
FROM public.voice_session_facts f
GROUP BY 1, 2, 3, 4, 5, 6;

COMMENT ON VIEW public.voice_session_facts_hourly IS
  'VTID-04776: hourly rollup of voice_session_facts per tenant x surface x role x provider x lang. security_invoker; service role only.';

REVOKE ALL ON public.voice_session_facts_hourly FROM anon, authenticated;
GRANT SELECT ON public.voice_session_facts_hourly TO service_role;

-- Best-effort rebuild from oasis_events. Operator action, never run by this
-- migration. Bounded: p_since is required and may not reach back more than
-- 30 days (oasis_events is large; each call scans only the start/stop/profile/
-- provider topics inside the window). Existing rows are never overwritten
-- (ON CONFLICT DO NOTHING), so re-running is safe and live rows win.
-- Outcome mirrors classifyVoiceSessionOutcome() in voice-session-facts.ts
-- in simplified form (no stall or close-code evidence in the events).
CREATE OR REPLACE FUNCTION public.voice_session_facts_backfill(p_since TIMESTAMPTZ)
RETURNS INTEGER
LANGUAGE plpgsql
SET search_path = public
AS $fn$
DECLARE
    v_inserted INTEGER;
BEGIN
    IF p_since IS NULL THEN
        RAISE EXCEPTION 'voice_session_facts_backfill: p_since is required';
    END IF;
    IF p_since < now() - interval '30 days' THEN
        RAISE EXCEPTION 'voice_session_facts_backfill: p_since % is older than 30 days; run it in slices', p_since;
    END IF;

    WITH starts AS (
        SELECT DISTINCT ON (e.metadata->>'session_id')
               e.metadata->>'session_id' AS session_id,
               e.created_at              AS started_at,
               e.metadata                AS md
          FROM public.oasis_events e
         WHERE e.topic = 'vtid.live.session.start'
           AND e.created_at >= p_since
           AND e.metadata ? 'session_id'
         ORDER BY e.metadata->>'session_id', e.created_at ASC
    ),
    stops AS (
        SELECT DISTINCT ON (e.metadata->>'session_id')
               e.metadata->>'session_id' AS session_id,
               e.created_at              AS ended_at,
               e.metadata                AS md
          FROM public.oasis_events e
         WHERE e.topic = 'vtid.live.session.stop'
           AND e.created_at >= p_since
           AND e.metadata ? 'session_id'
         ORDER BY e.metadata->>'session_id', e.created_at ASC
    ),
    profiles AS (
        SELECT DISTINCT ON (e.metadata->>'session_id')
               e.metadata->>'session_id' AS session_id,
               e.metadata                AS md
          FROM public.oasis_events e
         WHERE e.topic = 'orb.session.profile.resolved'
           AND e.created_at >= p_since
           AND e.metadata ? 'session_id'
         ORDER BY e.metadata->>'session_id', e.created_at ASC
    ),
    providers AS (
        SELECT DISTINCT ON (e.metadata->>'session_id')
               e.metadata->>'session_id' AS session_id,
               e.metadata                AS md
          FROM public.oasis_events e
         WHERE e.topic = 'orb.upstream.provider.selected'
           AND e.created_at >= p_since
           AND e.metadata ? 'session_id'
         ORDER BY e.metadata->>'session_id', e.created_at DESC
    ),
    joined AS (
        SELECT
            s.session_id,
            CASE WHEN (s.md->>'tenant_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                 THEN (s.md->>'tenant_id')::uuid END                                         AS tenant_id,
            CASE WHEN (s.md->>'user_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                 THEN (s.md->>'user_id')::uuid END                                           AS user_id,
            COALESCE((s.md->>'is_anonymous')::boolean,
                     COALESCE(s.md->>'user_id', 'anonymous') = 'anonymous'
                     OR (s.md->>'user_id') LIKE 'anon-%')                                    AS is_anonymous,
            COALESCE(p.md->>'surface', CASE WHEN s.md->>'transport' = 'livekit' THEN 'vitanaland' END) AS surface,
            COALESCE(NULLIF(st.md->>'role', ''), NULLIF(s.md->>'active_role', ''), NULLIF(p.md->>'role', '')) AS role,
            p.md->>'persona_key'                                                             AS persona_key,
            p.md->>'resolution'                                                              AS profile_resolution,
            COALESCE(NULLIF(s.md->>'lang', ''), NULLIF(st.md->>'lang', ''))                  AS lang,
            CASE COALESCE(pv.md->>'provider', CASE WHEN s.md->>'transport' = 'livekit' THEN 'livekit' END)
                 WHEN 'nova_sonic' THEN 'nova_sonic'
                 WHEN 'cascaded'   THEN 'cascade'
                 WHEN 'vertex'     THEN 'vertex_serbian_bridge'
                 WHEN 'livekit'    THEN 'livekit'
                 ELSE 'unknown' END                                                          AS provider,
            pv.md->>'reason'                                                                 AS selection_reason,
            CASE s.md->>'transport'
                 WHEN 'livekit' THEN 'livekit'
                 WHEN 'websocket' THEN 'ws'
                 WHEN 'ws' THEN 'ws'
                 WHEN 'sse' THEN 'sse'
                 ELSE NULL END                                                               AS transport,
            (s.md->>'is_mobile')::boolean                                                    AS is_mobile,
            s.started_at,
            st.ended_at,
            NULLIF(st.md->>'duration_ms', '')::numeric::int                                  AS duration_ms,
            NULLIF(st.md->>'turn_count', '')::numeric::int                                   AS turn_count,
            NULLIF(st.md->>'user_turns', '')::numeric::int                                   AS user_turns,
            NULLIF(st.md->>'model_turns', '')::numeric::int                                  AS model_turns,
            NULLIF(st.md->>'audio_in_chunks', '')::numeric::int                              AS audio_in_chunks,
            NULLIF(st.md->>'audio_out_chunks', '')::numeric::int                             AS audio_out_chunks,
            NULLIF(st.md->>'stall_count', '')::numeric::int                                  AS stall_count,
            st.md->>'reason'                                                                 AS close_reason
        FROM starts s
        LEFT JOIN stops st     ON st.session_id = s.session_id
        LEFT JOIN profiles p   ON p.session_id  = s.session_id
        LEFT JOIN providers pv ON pv.session_id = s.session_id
        WHERE s.session_id IS NOT NULL AND s.session_id <> ''
    )
    INSERT INTO public.voice_session_facts AS f (
        session_id, tenant_id, user_id, is_anonymous, surface, role, persona_key, profile_resolution,
        lang, provider, selection_reason, transport, is_mobile, started_at, ended_at, last_activity_at,
        duration_ms, turn_count, user_turns, model_turns, audio_in_chunks, audio_out_chunks,
        close_reason, stall_count, outcome
    )
    SELECT
        j.session_id, j.tenant_id, j.user_id, j.is_anonymous, j.surface, j.role, j.persona_key, j.profile_resolution,
        j.lang, j.provider, j.selection_reason, j.transport, j.is_mobile, j.started_at, j.ended_at,
        COALESCE(j.ended_at, j.started_at),
        j.duration_ms, j.turn_count, j.user_turns, j.model_turns, j.audio_in_chunks, j.audio_out_chunks,
        j.close_reason, j.stall_count,
        CASE
            WHEN j.ended_at IS NULL AND j.started_at > now() - interval '15 minutes' THEN 'active'
            WHEN j.ended_at IS NULL THEN 'abandoned'
            WHEN j.close_reason ~* '(error|failed|exception)' THEN 'error'
            WHEN j.close_reason IN ('idle_no_engagement') THEN 'abandoned'
            WHEN COALESCE(j.audio_out_chunks, 0) = 0 AND COALESCE(j.audio_in_chunks, 0) > 0 THEN 'one_way'
            WHEN COALESCE(j.audio_out_chunks, 0) = 0 AND COALESCE(j.duration_ms, 0) >= 5000 THEN 'silent'
            WHEN COALESCE(j.audio_out_chunks, 0) = 0 THEN 'abandoned'
            WHEN COALESCE(j.audio_in_chunks, 0) = 0 AND COALESCE(j.turn_count, 0) = 0
                 AND COALESCE(j.duration_ms, 0) >= 30000 THEN 'one_way'
            ELSE 'ok'
        END
    FROM joined j
    ON CONFLICT (session_id) DO NOTHING;

    GET DIAGNOSTICS v_inserted = ROW_COUNT;
    RETURN v_inserted;
END;
$fn$;

COMMENT ON FUNCTION public.voice_session_facts_backfill(TIMESTAMPTZ) IS
  'VTID-04776: best-effort rebuild of voice_session_facts from oasis_events since p_since (max 30 days back). Operator action; ON CONFLICT DO NOTHING. Returns rows inserted.';

REVOKE ALL ON FUNCTION public.voice_session_facts_backfill(TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.voice_session_facts_backfill(TIMESTAMPTZ) TO service_role;
