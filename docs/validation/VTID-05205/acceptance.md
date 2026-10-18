# VTID-05205 — New-member welcome, lane `team-welcome-backend`: three team welcome DMs (Mariia, Jovana, Alex Blue)

Plan: `.kiro/specs/new-member-welcome/` — sparred 4 rounds, CONVERGED, owner approved at Gate 1 on 2026-10-15 (plan hash `f7cdefc3043249c5`). Record copied to `docs/validation/VTID-05205/plan-sparring.md`. Lane tasks A1–A7 in `tasks.md`; design in the plan block, Part A and S1/S2/S5/S6.

**Nothing is sent by this change in any environment.** Sending needs, on the production gateway only: `FEATURE_WELCOME_TEAM_ENV` live, `WELCOME_ROLLOUT_AT`, `WELCOME_TEAM_MODE=live`, `WELCOME_TEAM_SEND_ENABLED=true` and `WELCOME_SENDER_NAMES_CONFIRMED=true`, and then only to members in `WELCOME_TEAM_PILOT_USER_IDS` until `WELCOME_TEAM_AUDIENCE=all`. None of those are set by this change. The staging gateway refuses the tick (409) and reports `disabled-on-staging`. The migration must be applied (`RUN-MIGRATION.yml`) before the tick leaves `off`.

AC-1 Config (`services/gateway/src/services/welcome-team/config.ts`): modes `disabled-on-staging | off | shadow | live`; staging always `disabled-on-staging`; `off` without the feature flag, without a valid `WELCOME_ROLLOUT_AT`, or without a mode; `live` only with BOTH `WELCOME_TEAM_SEND_ENABLED=true` and `WELCOME_SENDER_NAMES_CONFIRMED=true`, otherwise `shadow` with the reason naming the missing switch. Sender ids (defaults: Mariia `67c971fc-…`, Jovana `c7d3260d-…`, Alex Blue `0adc6ff6-…`), stagger days (0/1/2), tenant (MAXINA), audience, pilot allowlist, min gap, per-tick cap and reviewed locales are env-configurable; invalid values fall back to the defaults.
TEST: services/gateway/test/vtid-05205-welcome-team.test.ts

AC-2 Send-once (`supabase/migrations/20261015150000_vtid_05205_welcome_team_claims.sql`): `welcome_team_claims` PK `(user_id, sender_slug)`; `claim_welcome_message` grants a pair once, returns `in_flight` for a pending claim (never re-claimed), `already_sent` after a send, allows one retry after a failed first attempt and then `retry_spent`; `finish_welcome_message` moves only pending rows and keeps the DM id and send time. RLS on, no policies, no grants to `anon`/`authenticated`; both functions SECURITY DEFINER, `service_role` only. One transaction, idempotent, re-runnable, no trigger, no change to any existing table.
TEST: services/gateway/test/vtid-05205-welcome-team.test.ts
TEST: docs/validation/VTID-05205/pglite-welcome-team-check.mjs (30 checks, outputs/pglite-welcome-team-check.txt)

AC-3 Timing (requirements 1.1–1.3): Mariia on the first tick after registration (≤ 15 min with the 15-minute schedule), Jovana from day 1, Alex from day 2; at most one welcome per member per tick and at least `WELCOME_TEAM_MIN_GAP_HOURS` (default 20) between two welcomes to the same member, so a late or backed-up tick never delivers two on one day. A member counts as registered once their `app_users` row exists.
TEST: services/gateway/test/vtid-05205-welcome-team.test.ts

AC-4 Once only (1.6): a 5-day simulation with a tick every 15 minutes, a repeated tick at the same instant and a further week of ticks produces exactly three DMs. A failed DM write is retried once on a later tick and never a third time; a failed push never undoes the DM.
TEST: services/gateway/test/vtid-05205-welcome-team.test.ts

AC-5 Who (1.7, 1.8): members whose primary membership predates `WELCOME_ROLLOUT_AT` get nothing; test/service accounts (`service_bot_accounts` ∪ `notification_test_actors`) get nothing; a failed exclusion lookup ends the tick before any write; a sender never welcomes themselves; a sender who is excluded or has no account sends nothing while the others continue. Closed pilot by default: only allowlisted members, an empty allowlist reaches nobody.
TEST: services/gateway/test/vtid-05205-welcome-team.test.ts

AC-6 The DM and replies (1.9): one `chat_messages` row authored by the sender's own account to the member (`message_type 'text'`, `metadata = { source: 'welcome_team', sender_slug, vtid, automated: true, done_by_vitana: false, locale }`, both vitana ids when known), so a reply is an ordinary DM in that sender's inbox. One push shaped like any DM from that person (`new_chat_message`, title = sender's display name, `url = /inbox/u/<sender>`).
TEST: services/gateway/test/vtid-05205-welcome-team.test.ts

AC-7 Language and wording (1.4, 1.5, S1): `tt()` catalog keys `welcome_team.{mariia,jovana,alex}.body` (with `{name}`, the member's first name) and `.body_noname`, in de, en, es, sr, fr, pt, ru, pl, zh, tr (`ar` intentionally untranslated, as the coverage suite requires); du/informal form; at most one emoji each. The recipient's locale (`getUserLocale`) is used when it is in `WELCOME_TEAM_READY_LOCALES` (default `de,en`), otherwise English. Alex's text contains no AI claim and no promise of an immediate reply, in every locale.
TEST: services/gateway/test/vtid-05205-welcome-team.test.ts
TEST: services/gateway/test/i18n/catalog-coverage.test.ts

AC-8 Transport (A5, S2): `POST /api/v1/scheduled-notifications/welcome-team-tick` — a sibling of the coach tick — enforces `X-Gateway-Internal` itself whatever `SCHEDULED_NOTIFICATIONS_AUTH_MODE` says (401 missing, 403 wrong, 503 no token configured), answers 409 on staging even with every switch on, and answers `{mode:"off"}` without touching the database when off. `GET /api/v1/welcome-team/status` is public and read-only and carries no member or account id. EventBridge job `gateway-welcome-team-tick` (every 15 minutes, production gateway, internal token) added to `scripts/aws/setup-eventbridge-cron-migration.sh` — not created by this change.
TEST: services/gateway/test/vtid-05205-welcome-team.test.ts
TEST: services/gateway/test/vtid-04226-eventbridge-test-contract-schedules.test.ts

AC-9 Shadow writes nothing: no claim, no DM, no push; only the `would_send` counts and one aggregate OASIS event.
TEST: services/gateway/test/vtid-05205-welcome-team.test.ts

AC-10 Regression: role separation (new route file claimed by the `community` atlas domain), customer support, operator pipeline, onboarding coach, companion messages, catalog coverage and every suite touching scheduled notifications, OASIS types, the i18n catalog or the router mounts stay green.
TEST: services/gateway/test/vtid-04560-role-separation-regression.test.ts
TEST: services/gateway/test/vtid-04456-customer-support-pipeline-regression.test.ts
TEST: services/gateway/test/vtid-04465-operator-pipeline-regression.test.ts
TEST: services/gateway/test/vtid-04892-onboarding-coach.test.ts
TEST: services/gateway/test/vtid-05099-companion-messages.test.ts

Decisions taken (inside the approved plan, most conservative option):
- **Pilot members are counted from the rollout.** The pilot allowlist reaches members who may have joined before `WELCOME_ROLLOUT_AT`; for them the stagger starts at the rollout time. Without this the closed pilot could reach nobody, because the cohort gate (S5) excludes everyone who joined earlier. Non-allowlisted members are never reached in pilot mode, and in `all` mode the cohort gate applies to everyone. Reviewer: please confirm or narrow (e.g. require the cohort gate in pilot mode too).
- **One push per welcome**, shaped exactly like a DM from that person (`new_chat_message`, the type `/send` uses), so the newcomer sees it like any message; the plan named the DM but not the push. Quiet hours, the member's chat preference and the admin switch apply as for every DM. A held or failed push never undoes the DM.
- **Registration complete = an `app_users` row exists** for the member (the same row the VTID-03089 welcome trigger waits for).
- **"Never on the same day"** is enforced by a minimum gap (default 20 h) between two welcomes to the same member plus one welcome per member per tick, not by the member's local calendar day — the claims carry no time zone, and the gap also covers a backed-up tick. An in-flight (pending) claim counts for the gap.
- **The tenant is pinned** (`WELCOME_TEAM_TENANT_ID`, default MAXINA `2e7528b8-…`): the senders are MAXINA members, so other tenants' newcomers are never messaged.
- **Shadow writes nothing at all** (no claim rows): a shadow claim would use up the pair before a real send.
- **No sender approval step** (owner decision 2026-10-15, plan S1): the seed wording from `content-welcome-seed.md` is used; the nine non-de/en locales are new translations and stay outside `WELCOME_TEAM_READY_LOCALES` (members in those locales get English) until the locale review.
- **Per-tick cap** default 25 DMs; the rest follow on the next tick.
- **Sender display names (S6)** are not changed by code: `live` stays unavailable until `WELCOME_SENDER_NAMES_CONFIRMED=true`. Read-only check 2026-10-15: Mariia's account shows "maksinamariia", Alex Blue's shows "Dragan Alexander".

ROUTE_MOUNT: new `services/gateway/src/routes/community-welcome-team.ts` mounted at `/api/v1/welcome-team` in `services/gateway/src/index.ts` (owner `community-welcome-team`); `POST /welcome-team-tick` added to `services/gateway/src/routes/scheduled-notifications.ts` (mounted at `/api/v1/scheduled-notifications`).
FINAL_URL: GET /api/v1/welcome-team/status; POST /api/v1/scheduled-notifications/welcome-team-tick
CURL_PROOF: staging checks in docs/validation/VTID-05205/staging-tests.json — GET /api/v1/welcome-team/status returns `mode: disabled-on-staging`; POST /api/v1/scheduled-notifications/welcome-team-tick without the token returns 401 (rejected probe, nothing runs).

OASIS_IMPACT: yes
OASIS_PROOF: `welcome_team.message.sent` / `welcome_team.message.failed` per real DM and `welcome_team.tick.completed` per tick that decided something (services/gateway/src/services/welcome-team/welcome-team-service.ts); types added to services/gateway/src/types/cicd.ts.
