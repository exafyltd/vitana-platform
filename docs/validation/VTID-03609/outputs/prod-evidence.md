# Production evidence — read-only queries against oasis_events / user_journey

## 1. Every greeting since the prod deploy took the wrong rung

```sql
select metadata->>'wake_opener' as wake_opener, count(*)
from oasis_events
where topic='orb.live.diag'
  and metadata->>'stage'='greeting_sent'
  and created_at > '2026-08-11 22:21:51+00'   -- prod container boot (commit a9b0a83)
group by 1 order by 2 desc;
```

```
wake_opener  | count
-------------+-------
override_v2  |     5
```

Zero `newday_overview`. Zero `safe_fast_newday_overview`.

## 2. All five were DUE a briefing

```sql
select user_id, last_full_briefing_date
from user_journey
where user_id in (
  select distinct (metadata->>'user_id')::uuid
  from oasis_events
  where topic='vtid.live.session.start'
    and created_at > now() - interval '12 hours'
    and metadata->>'user_id' is not null
);
```

```
last_full_briefing_date
-----------------------
2026-07-28
2026-07-24
(null)
2026-07-08
(null)
2026-07-29
2026-07-25
2026-08-01
```

Today is `2026-08-12`. `briefingDue()` is `!(d >= todayTz)`, so every one of these
is due — including the two NULLs.

## 3. They reached the SYNC ladder, not the safe-fast one

```sql
select metadata->>'session_id' as sid,
       string_agg(distinct metadata->>'stage', ', ') as stages
from oasis_events
where topic='orb.live.diag'
  and metadata->>'session_id' in (
    'live-55ff0e1b-6d49-4dd4-a399-df597ed81e2d',
    'live-6ab7f809-7e0c-416e-965a-7baf2b1fbf29',
    'live-27ea0b04-6243-4d1d-ac5a-8b24e3fa8d57',
    'live-294c26a0-7478-4c01-bd4e-7b2351212550',
    'live-edfbef85-30c0-431e-9735-d98650290ef0')
  and metadata->>'stage' in ('greeting_context_pending','greeting_sent')
group by 1;
```

Every row returns `greeting_sent` only — **no `greeting_context_pending`**. That
diag fires iff `contextReadyResolved === false`, i.e. iff the safe-fast block was
entered. Its absence on all five is what rules out "the safe-fast ladder handled
these" and pins the failure inside the sync branch added by VTID-03607.

## 4. Why nothing said which gate rejected them

VTID-03607's branch emitted no diagnostic on the not-fired path. `override_v2` is
what the plain sync ladder emits too, so the telemetry could not distinguish:

- the pre-guard rejected (and on which gate),
- `shouldAttemptNewdayOverview` rejected,
- the gather returned nothing,
- the payload had no content worth speaking.

That gap is why this needed a second round, and it is what the new
`newday_briefing_eval` diag closes.

## 5. Sibling verification (VTID-03592, already merged and live)

The duplicate-`turnComplete` fix in the same branch is confirmed on the same
traffic — for all 4 sessions since the deploy, the number of `turn_complete`
events equals the number of DISTINCT `turn_count` values, i.e. no turn boundary
is booked twice. Before the fix, prod session `live-37aa4388` booked two
`turn_complete` events (turn_count 0, then 1) for a single greeting with
`audio_out` unchanged at 45 across both.
