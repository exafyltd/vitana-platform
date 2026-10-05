# VTID-04886 — Command Hub Overview Phase 3: Ack / Snooze, timeline, sparklines, P1 notifications

Plan A (Command Hub Overview), Phase 3. Sparring record: `plan-sparring.md` (points at
`docs/validation/VTID-04869/plan-sparring.md`, converged, owner-approved 2026-10-04). Builds on
Phase 1 (VTID-04876) and Phase 2 (VTID-04885).

What changed:
- the table `ops_attention_acks` (migration + DATABASE_SCHEMA.md);
- `POST /api/v1/ops/attention/ack` and `/snooze` (exafy_admin, Zod-validated, P1 never snoozable,
  OASIS `ops.attention.acked` / `ops.attention.snoozed`);
- acked items are marked and snoozed items are hidden and counted in `GET /ops/attention`;
- a 24 h change & incident timeline and two sparklines are added to the response;
- in the cockpit: Ack/Snooze buttons with a reason form, the hidden list, the timeline, the
  sparklines, and an opt-in P1 browser notification.

No live endpoint, database or AWS API was called while building this. Every test uses mocks, and
the migration ran only on a throwaway local Postgres (`commands.log`).

## Migration

AC-1: `supabase/migrations/20261005100000_vtid_04886_ops_attention_acks.sql` creates
`ops_attention_acks` with these columns:
- `env`, `fingerprint`, `action` (`ack`|`snooze`);
- `reason` (NOT NULL, 3–500 chars after trim);
- `severity`, `actor_user_id`, `actor_email`;
- `vtid` (nullable, `VTID-\d{4,5}`);
- `created_at` and `expires_at` (NOT NULL, CHECK `created_at < expires_at <= created_at + 24 h`).

A CHECK also refuses a P1 snooze. RLS is on, with REVOKE from PUBLIC/anon/authenticated, GRANT to
service_role only, and no policy. The migration is idempotent. `DATABASE_SCHEMA.md` is updated. Not
applied by this session.
TEST: services/gateway/test/vtid-04886-ops-attention-acks-timeline.test.ts ("the migration: table, CHECKs")
TEST: scripts/ci/sql-tests/run-ops-attention-acks-test.sh (applied twice on a throwaway Postgres 16; every CHECK, RLS and grant asserted — outputs/09-sql-harness.txt)

## Routes

AC-2: `POST /api/v1/ops/attention/ack` and `POST /api/v1/ops/attention/snooze` are on the existing
`/api/v1/ops/attention` router (mounted after `express.json()`), behind `requireAdminAuth`. Without
a token they answer 401 JSON, and nothing is written or emitted.
TEST: services/gateway/test/vtid-04886-ops-attention-ack-route.test.ts ("401 JSON without an Authorization header", "a non-admin is refused", "index.ts: the ack/snooze routes")
CURL: POST https://preview-aws-gateway.vitanaland.com/api/v1/ops/attention/ack (no token, no body) -> 401 application/json (staging-tests.json, rejected write probe)

AC-3: The body is Zod-validated (`.strict()`): `fingerprint`, `reason` (required, 3–500),
`duration_minutes` (an integer from 5 to 1440, so expiry is at most 24 h), and optional `vtid`. Any
other shape is 400 `invalid_body` with the issues listed. The write side refuses more than 24 h on
its own too.
TEST: services/gateway/test/vtid-04886-ops-attention-ack-route.test.ts ("Zod: reason required, expiry <= 24 h", "the write-side cap holds")

AC-4: P1 is ackable but never snoozable: snoozing a P1 is 400 `p1_not_snoozable` and nothing is
written. The severity comes from the server's current computation, never from the client. An item
that is not open now is 404 `not_open`, and a fingerprint from another env is 400 `wrong_env`.
TEST: services/gateway/test/vtid-04886-ops-attention-ack-route.test.ts ("P1 is ackable but NEVER snoozable", "not open now is 404")

AC-5: Each action writes one row with the actor (exafy_admin user id and email), the reason, the
severity, the optional VTID and the expiry. It emits one OASIS event, `ops.attention.acked` or
`ops.attention.snoozed`, with the fingerprint, action, severity, reason, expiry and ack id. An OASIS
failure is logged and reported (`oasis_emitted: false`), and the action stands. The cache is
invalidated, so the next GET shows the effect.
TEST: services/gateway/test/vtid-04886-ops-attention-ack-route.test.ts ("snooze a P2: one row", "ack emits ops.attention.acked")
OASIS_PROOF: ops.attention.acked / ops.attention.snoozed added to the `CicdEventType` union in services/gateway/src/types/cicd.ts; emitted only by recordOpsAttentionAction() (services/ops-attention.ts); asserted with a fake emitter in the route test ("the OASIS event types are in the CicdEventType union").

## Aggregator

AC-6: The latest unexpired ack row per fingerprint wins.
- An acked item stays in `items` with `ack` set (who, why, until), and `counts.acked` counts it.
- A snoozed item moves to `hidden` until its expiry. `counts.hidden` and each domain's `hidden` say
  how many; nothing is silently dropped.
- A P1 is never hidden: a snoozed fingerprint that reaches P1 is shown, marked `snooze_overridden`.
- An ack read failure or a 3 s timeout hides nothing and is reported in `acks_error`.
TEST: services/gateway/test/vtid-04886-ops-attention-acks-timeline.test.ts ("applyAcks", "buildOpsAttention with acks")

AC-7: The 24 h timeline comes from the deploy, verify, rollback and kill-switch topics the adapters
already read, plus governance control changes (`oasis_events`, LIMIT 200) and `self_healing_log`
(the read is shared with the autonomy adapter). It is newest first, capped at 50, and has its own
3 s budget. A failed read gives `timeline.error` and `sparklines: null`, never an empty "quiet day".
TEST: services/gateway/test/vtid-04886-ops-attention-acks-timeline.test.ts ("timeline + sparklines", "production reads (VTID-04886)")

AC-8: Sparklines: two 24-bucket hourly series derived from the timeline: deploys (non-failed deploy
events) and incidents (failures, rollbacks, verify failures, self-heal escalations, kill switch
engaged). True SLIs (error rate, voice success, latency) are omitted. No cheap series exists for
them: the old `/ops/overview-timeseries` errors series scans up to 5000 unindexed rows and swallows
its own failures.
TEST: services/gateway/test/vtid-04886-ops-attention-acks-timeline.test.ts ("sparklinesFrom: 24 hourly buckets")

## Frontend

AC-9: Every queue item has an Ack button, and every non-P1 item has a Snooze button. A P1 shows "P1
cannot be snoozed". The inline form asks for a required reason (3–500), an expiry of at most 24 h
(15 min to 24 h) and an optional VTID. Submit POSTs and refetches; an error stays in the form
(`role="alert"`). A poll never wipes an open form. Acked items are de-emphasised and show who, why
and until. Snoozed items are listed in a "N snoozed item(s) hidden" disclosure, and the status bar
counts them.
TEST: services/gateway/test/command-hub/vtid-04886-overview-ack-timeline.test.ts ("Ack / Snooze controls")
UI: docs/validation/VTID-04886/outputs/p3-ack-form.png, p3-cockpit-after-snooze.png, p3-cockpit-desktop.png, p3-cockpit-mobile.png

AC-10: There are no inline handlers. One delegated click listener and one delegated submit listener
read `data-action`. The CSS uses logical properties only, targets are ≥ 24 px, and there is no CSP
pattern in added lines. The Command Hub is admin-facing and English by design.
TEST: services/gateway/test/command-hub/vtid-04886-overview-ack-timeline.test.ts ("delegated listeners only", "styles and asset version")

AC-11: The timeline renders under the tiles. The sparklines are attribute-only inline SVG with an
`aria-label`, shown in the status bar. "Timeline unavailable … this is not a quiet day" appears on a
read error.
TEST: services/gateway/test/command-hub/vtid-04886-overview-ack-timeline.test.ts ("timeline and sparklines")
UI: docs/validation/VTID-04886/outputs/p3-cockpit-desktop.png

AC-12: The P1 browser notification is opt-in and off by default. It is a "P1 alerts: on/off" toggle
(`aria-pressed`) stored in `localStorage` (`vitana.opsAttention.p1Notify`); every read and write is
wrapped in try/catch, so blocked storage means off. Permission is asked for only when the toggle is
turned on. A notification fires only when a NEW fingerprint reaches P1. Nothing fires on the first
load or when the toggle is turned on, and nothing fires twice for the same P1 or for a P2.
TEST: services/gateway/test/command-hub/vtid-04886-overview-ack-timeline.test.ts ("opt-in P1 browser notifications")

## Gates

AC-13: The ownership guard allowlists VTID-04886. The asset version moves forward to
`20261029-vtid-04886`, and the older staging suites follow (VTID-04696). The symbol index is
regenerated with its tool. The standing suites `test:operator` (42e) and `test:roles` (42h, atlas)
stay green. No route file was added.
TEST: services/gateway/test/vtid-04696-staging-checks-follow-asset-bumps.test.ts
TEST: services/gateway/test/scripts/command-hub-ownership-guard.test.ts
TEST: services/gateway/test/vtid-04465-operator-pipeline-regression.test.ts
TEST: services/gateway/test/vtid-04560-role-separation-regression.test.ts

ROUTE_MOUNT: no new mount. `router.post('/ack', requireAdminAuth, …)` and `router.post('/snooze',
requireAdminAuth, …)` were added to services/gateway/src/routes/ops-attention.ts, which is mounted
by `mountRouterSync(app, '/api/v1/ops/attention', opsAttentionRouter, { owner: 'ops-attention' })`
in index.ts, after `express.json()`.
FINAL_URL: POST https://preview-aws-gateway.vitanaland.com/api/v1/ops/attention/ack and …/snooze
CURL_PROOF:
- Before merge: not run. No live endpoint may be called from this session, so mount, auth and
  behaviour are proven in-process with supertest (AC-2 to AC-5).
- After deploy: unauthenticated rejected-write probes must answer `401 application/json`
  (staging-tests.json). No real ack is ever written on staging, because staging writes production
  data (rule 48).

## Known gaps

- The migration is not applied. Until it is, the ack read fails, `acks_error` says so and every
  item is shown, and an ack or snooze POST answers 500 `ack_failed`.
- The SQL harness runs locally only. No CI workflow was added for it (the erase-user-data harness
  has one, SQL-ERASE-USER-DATA.yml).
- Sparklines are event counts (deploys, incidents), not latency or error-rate SLIs.
- The notification needs the Overview to be open: polling only, `/events/stream` is not used (F4).
