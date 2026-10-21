-- VTID-05039 — onboarding baseline, read-only. Cohort: primary members who joined in the
-- 60 days before :as_of, service/test accounts (both allowlists) excluded.
-- Day N return = any auth activity (login or token refresh) by the member in that window.
with params as (select timestamptz '2026-10-10 00:00:00+00' as as_of),
cohort as (
  select ut.user_id, ut.tenant_id, ut.created_at as joined_at
  from user_tenants ut, params p
  where ut.is_primary
    and ut.created_at >= p.as_of - interval '60 days' and ut.created_at < p.as_of
    and not exists (select 1 from service_bot_accounts s where s.user_id = ut.user_id)
    and not exists (select 1 from notification_test_actors n where n.user_id = ut.user_id)
),
auth_act as (
  select (a.payload->>'actor_id')::uuid as user_id, a.created_at
  from auth.audit_log_entries a
  where a.payload->>'action' in ('login', 'token_refreshed')
),
per_member as (
  select c.user_id, c.joined_at,
    c.joined_at <= (select as_of from params) - interval '2 days' as d1_eligible,
    c.joined_at <= (select as_of from params) - interval '7 days' as d7_eligible,
    exists (select 1 from auth_act x where x.user_id = c.user_id
            and x.created_at >= c.joined_at + interval '1 day' and x.created_at < c.joined_at + interval '2 days') as d1,
    exists (select 1 from auth_act x where x.user_id = c.user_id
            and x.created_at >= c.joined_at + interval '2 days' and x.created_at < c.joined_at + interval '7 days') as d7,
    (select min(e.created_at) from oasis_events e
      where e.topic = 'vtid.live.session.start' and e.metadata->>'user_id' = c.user_id::text
        and e.created_at >= c.joined_at) as first_orb,
    exists (select 1 from chat_messages w where w.sender_id = c.user_id and w.metadata->>'source' = 'welcome_chat') as got_welcome_dm,
    exists (select 1 from chat_messages w
             join chat_messages r on r.sender_id = w.receiver_id and r.receiver_id = c.user_id
                                  and r.created_at > w.created_at and r.created_at < w.created_at + interval '7 days'
            where w.sender_id = c.user_id and w.metadata->>'source' = 'welcome_chat') as welcome_dm_replied
  from cohort c
)
select
  count(*) as joiners_60d,
  count(*) filter (where d1_eligible) as d1_eligible,
  round(100.0 * count(*) filter (where d1_eligible and d1) / nullif(count(*) filter (where d1_eligible), 0), 1) as d1_return_pct,
  count(*) filter (where d7_eligible) as d7_eligible,
  round(100.0 * count(*) filter (where d7_eligible and d7) / nullif(count(*) filter (where d7_eligible), 0), 1) as d2_7_return_pct,
  count(*) filter (where first_orb is not null) as had_orb_session,
  round(100.0 * count(*) filter (where first_orb is not null) / nullif(count(*), 0), 1) as orb_session_pct,
  round((percentile_cont(0.5) within group (order by extract(epoch from first_orb - joined_at) / 3600.0)
          filter (where first_orb is not null))::numeric, 1) as median_hours_to_first_orb,
  count(*) filter (where got_welcome_dm) as welcome_dm_sent,
  round(100.0 * count(*) filter (where welcome_dm_replied) / nullif(count(*) filter (where got_welcome_dm), 0), 1) as welcome_dm_reply_pct,
  (select min(created_at)::date from auth.audit_log_entries) as audit_log_since,
  (select min(created_at)::date from oasis_events where topic = 'vtid.live.session.start') as orb_events_since
from per_member;
