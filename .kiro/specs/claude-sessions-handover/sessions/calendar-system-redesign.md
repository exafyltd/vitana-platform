# D - Calendar system redesign (session_01RP9hg2QXWdizqxMvqgqHyq)
- Created 2026-09-23, last updated 2026-10-13 18:21 UTC; status idle (review_ready). Branch claude/vitanaland-calendar-redesign-ryfg1l (both repos). Repos: vitana-v1, vitana-platform.
## Goal
Redesign the Vitanaland calendar and add shared calendar events/invites (design VTID-04998, owner-approved decisions 1-10), delivered in phases.
## Done
- Many earlier calendar PRs in both repos (e.g. VTID-04952/04956/04978/04994-04997 platform+v1 PRs, e.g. exafyltd/vitana-v1#1265, #1335) - state seen as closed; only listed in search, merge not individually verified.
- exafyltd/vitana-platform#4054 VTID-04998 design doc (design only) - closed (merge unverified).
- exafyltd/vitana-platform#4061 VTID-05104 invites Phase 1 (calendar-invite-guard.ts: test-account/tenant/relationship/quotas, group cap 20, generic push text) - MERGED 2026-10-12. Session reported it live in production (gateway c8d828abd425) at 10:50 UTC 10-13, ledger row closed.
## State now
- No open PR seen. Invites Phase 2 (server side of shared events) plan was sparred (2 rounds, verdict converged, plan hash 554f2b4ff42973b5) and posted as Gate 1 at 18:21 UTC 10-13: "Do you approve this plan?". No VTID allocated yet, no code written. Sparring record only in the session scratchpad (/tmp/claude-0/-home-user/b72418a1-.../scratchpad/plan-invites-phase2.md) - NOT in git; may be lost.
- Phase 2 scope: migration (calendar_shared_events, calendar_shared_event_members, RLS, replace 2 permissive policies on calendar_invite_responses), service calendar-shared-events.ts, 8 routes under /calendar behind CALENDAR_SHARED_EVENTS_ENABLED + per-tenant allow list, requireAuth+requireTenant, request-account-deletion list update, BEFORE DELETE trigger, DATABASE_SCHEMA.md.
- Prod: Phase 1 live; production also carries unreviewed commits 05125,05127,05128,05123,05129,05118,05133,05135 (shipped by full-snapshot deploys not by this session).
## Blocked on / needs owner
- Gate 1 approval of the Phase 2 plan (unanswered as far as seen; no human reply in the last events).
## Next steps for Kiro
1. Get owner "yes" on Phase 2 plan (or policy approval); re-create the sparring record in docs/validation/<VTID>/plan-sparring.md (the plan file is only in the old session scratchpad; the Gate 1 message text in the transcript holds the full plan).
2. After approval: allocate VTID with sparring id, implement per plan, tests (Jest in-memory + migration test on throwaway Postgres + 2 mutation checks), PR.
3. Claude-Code-only: merge, staging verify watch, Gate 2, migration apply after Gate 2 (RUN-MIGRATION), production.
4. Later phases 3-4 (frontend, notifications, flag/tenant turn-on) need own plans + sparring.
## Gotchas/lessons
- Calendar router uses optionalAuth at router level; new routes need per-route requireAuth+requireTenant.
- source_ref_type is free text (no CHECK); valid_source_type already includes 'invite'.
- Account-deletion list is hand-kept in supabase/functions/request-account-deletion; add new tables there.
- Never write as test user / community content on any host.
