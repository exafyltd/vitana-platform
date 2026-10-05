# VTID-04892 — Vitana Onboarding Assistant, slice 1: coach engine (shadow only)

Plan: `docs/plans/VITANA-ONBOARDING-ASSISTANT-PLAN.md` v3 — sparred (3 rounds CONVERGED + confirmation pass), owner approved 2026-10-05. Record: `docs/validation/VTID-04892/plan-sparring.md` (final plan hash `0e9d13e5…`).

Slice 1 decides, for each new member in the cohort, the single next onboarding step and whether Vitana would reach out today, and records it in coach-owned tables. **It sends nothing.**

Scope note — narrower than plan §5 slice 1, on purpose: the plan's "milestone extensions" (first ORB conversation, push granted, episodes heard, first DM reply) are **not** in this slice. Every milestone award emits `user.milestone.reached`, which AP-0411/AP-0412/AP-0504 consume, and the production reward sweep awards milestones on its own — so adding milestones here could reach members, which slice 1 must never do. They move to the slice that turns the coach live, with their fan-out suppressed, sparred there. The coach reads the milestones that already exist.

AC-1 Stages and the ladder: tenure → d0…d61_90 → done at 90 days; the ladder teaches in plan order (listen to the first episode → profile → diary → group → connection/RSVP → diary streak → invite), only steps the member is far enough in for, and uses only milestones `milestone-service.ts` already detects.
TEST: services/gateway/test/vtid-04892-onboarding-coach.test.ts

AC-2 One member, one local day: opt-out, the 90-day window and snooze stop the coach; ×2 back-off after each ignored touch, pause after 3; the Audiobook reminder owns the day when set and today's episode is not heard, or when it was already sent today (plan §4.7, sparring N5/M2); never a second touch on the same local day; a pilot stage override wins over tenure; the day is the member's local date.
TEST: services/gateway/test/vtid-04892-onboarding-coach.test.ts

AC-3 Mode: never on staging (staging shares the production database); off without FEATURE_ONBOARDING_ASSISTANT_ENV live or a valid VOA_ROLLOUT_DATE; no live mode in this slice (VOA_MODE=live still runs shadow, reported `live_not_available`).
TEST: services/gateway/test/vtid-04892-onboarding-coach.test.ts

AC-4 The shadow tick writes only `onboarding_coach_state` and `onboarding_coach_decisions` (upserts, one decision row per member per local day), calls no RPC, emits one aggregate `onboarding.coach.tick_completed` per tick and `onboarding.coach.stage_changed` only for a real stage change; test/service accounts are excluded with the strict lookup and a failed lookup skips the whole tick; a 90-day simulation graduates the member; the coach code contains no send path (notifyUser, push, chat_messages, profile_posts, recordTouch, credit_wallet, claim).
TEST: services/gateway/test/vtid-04892-onboarding-coach.test.ts

AC-5 The tick enforces X-Gateway-Internal itself whatever SCHEDULED_NOTIFICATIONS_AUTH_MODE says (401 missing, 403 wrong, 503 not configured) and the staging gateway refuses it with 409 even with a valid token; GET /api/v1/onboarding-coach/status returns only the mode. Mutation-checked: removing the token check fails 2 tests; removing the Audiobook give-way fails 1.
TEST: services/gateway/test/vtid-04892-onboarding-coach.test.ts

AC-6 Migration `20261005130000_vtid_04892_onboarding_coach.sql`: coach state (members read their own row), decision log and touch ledger with RLS and no client writes; `claim_onboarding_touch` gives one touch per member per local day with exactly one retry after a failed send, `finish_onboarding_touch` moves only pending rows, both service_role only; the pacer's `user_proactive_touches.surface` CHECK is widened to the code's 11 surfaces + `onboarding_coach` (NOT VALID, then VALIDATE; live rows checked read-only first: only priority_card and welcome_banner exist). Applied to a throwaway Postgres twice, 27 checks; an unknown live surface aborts the whole migration with nothing half-applied.
TEST: docs/validation/VTID-04892/pglite-onboarding-coach-check.mjs (outputs/pglite-onboarding-coach.txt)

AC-7 The new route file is claimed by the `health` atlas domain; the role-separation suite stays green.
TEST: services/gateway/test/vtid-04560-role-separation-regression.test.ts

Behaviour change to note (from AC-6): the four newer pacer surfaces (did_you_know_card, voice_opener_tour, voice_opener_initiative, vitana_responsibility_message) were rejected by the old CHECK, so their touches were never recorded and never counted toward the daily cap. After this migration they are recorded and counted, as the pacer was designed.

ROUTE_MOUNT: services/gateway/src/routes/onboarding-coach.ts mounted at /api/v1/onboarding-coach in services/gateway/src/index.ts (owner 'onboarding-coach'); POST /onboarding-coach-tick added to services/gateway/src/routes/scheduled-notifications.ts (mounted at /api/v1/scheduled-notifications)
FINAL_URL: GET /api/v1/onboarding-coach/status; POST /api/v1/scheduled-notifications/onboarding-coach-tick
CURL_PROOF: staging checks in docs/validation/VTID-04892/staging-tests.json — GET status returns JSON `mode: disabled-on-staging`; an untokened POST to the tick returns 401 JSON (rejected probe, no write).

OASIS_IMPACT: yes
OASIS_PROOF: one `onboarding.coach.tick_completed` per tick with its counters and `onboarding.coach.stage_changed` per real member stage change (services/gateway/src/services/onboarding-coach/coach-service.ts; topics added to src/types/cicd.ts). No per-member-per-tick events.
