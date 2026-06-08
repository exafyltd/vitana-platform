-- ============================================================================
-- BOOTSTRAP-ORB-SESSION-CHURN — verification queries
-- ============================================================================
-- Phase 3 of the ORB voice session-churn fix. Run these against the VITANA
-- Supabase project (oasis_events) BEFORE and AFTER the gateway + client deploy
-- to confirm the supersede rate drops and session reuse kicks in.
--
-- The event-type lives in `oasis_events.topic`; per-session detail is in
-- `metadata` (jsonb): reason, turn_count, user_id, session_id, duration_ms.
--
-- ----------------------------------------------------------------------------
-- BASELINE (measured 2026-06-07, pre-fix, ~7 days of dev data):
--   starts:                722
--   stops:                 756
--     expired_ttl:         264   (100.0% zero-turn, ~33 min median life)
--     user-ended:          263   ( 13.7% zero-turn,    20s median life)
--     superseded:          229   ( 89.5% zero-turn,    72s median life)  <-- target
--   superseded-zero-turn:  205   of which 198 had the next start within 5s
--   sessions never used:   469 / 722  (65%)  [superseded-0 + expired-0]
--   target after fix: superseded_by_new_session zero-turn -> near 0,
--                     replaced by `deduplicated=true` reuse events.
-- ----------------------------------------------------------------------------

-- (1) Stop-reason breakdown — the headline. Watch `superseded_by_new_session`
--     collapse and its zero-turn share fall.
select
  coalesce(metadata->>'reason','(none/user_ended)')                              as reason,
  count(*)                                                                       as stops,
  count(*) filter (where (metadata->>'turn_count')::int = 0)                     as zero_turn,
  round(100.0 * count(*) filter (where (metadata->>'turn_count')::int = 0)
        / nullif(count(*),0), 1)                                                 as zero_turn_pct,
  round((percentile_cont(0.5) within group (
        order by (metadata->>'duration_ms')::numeric) / 1000.0)::numeric, 1)     as median_life_s
from oasis_events
where topic = 'vtid.live.session.stop'
  and created_at > now() - interval '14 days'
group by 1
order by stops desc;

-- (2) Reuse adoption — should be ~0 before deploy, then rise to roughly the old
--     supersede volume. Broken out by the client-declared start_cause.
select
  coalesce(metadata->>'start_cause','(unset)')      as start_cause,
  count(*)                                           as reuse_hits,
  round(avg((metadata->>'reused_age_ms')::numeric)::numeric, 0) as avg_reused_age_ms
from oasis_events
where topic = 'vtid.live.session.start'
  and (metadata->>'deduplicated') = 'true'
  and created_at > now() - interval '14 days'
group by 1
order by reuse_hits desc;

-- (3) Churn ratio — supersedes per start. Pre-fix ~0.32; target well below 0.05.
select
  count(*) filter (where topic = 'vtid.live.session.start'
                     and coalesce((metadata->>'deduplicated')::bool,false) = false) as real_starts,
  count(*) filter (where topic = 'vtid.live.session.stop'
                     and metadata->>'reason' = 'superseded_by_new_session')         as supersedes,
  round(
    count(*) filter (where topic = 'vtid.live.session.stop'
                       and metadata->>'reason' = 'superseded_by_new_session')::numeric
    / nullif(count(*) filter (where topic = 'vtid.live.session.start'
                       and coalesce((metadata->>'deduplicated')::bool,false) = false),0),
    3)                                                                              as supersede_per_start
from oasis_events
where topic in ('vtid.live.session.start','vtid.live.session.stop')
  and created_at > now() - interval '14 days';
