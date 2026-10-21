# VTID-04371 — Conversation rebuild WS-0.7: hourly metrics rollup + Command Hub dashboards

Plan v1 (Conversation Intelligence Rebuild), Phase 0, workstream WS-0.7.
Ships in PR #3614 as a companion to VTID-04339 (VTID-04246 precedent).

## What was missing

- The Command Hub could not answer "is the conversation fast, reliable, and
  learning?"
  - Conversation → Monitor listed the last 100 `greeting_sent` rows and
    nothing else.
  - Assistant → Metrics was a placeholder (VTID-01218D).
- Computing these numbers on page load would mean scanning `oasis_events`.
  That table has no plain `created_at` index, and a query shaped like that
  starved the shared database once already (VTID-03980).

## Fix

- **New table `conversation_metrics_hourly`.** One row per (hour, metric,
  dimension).
  - Filled by `conversation_metrics_rollup_hour()`. Every source read filters
    by `topic` first, so it is an index range scan on
    `idx_oasis_events_topic_created_desc`.
  - pg_cron `conversation-metrics-hourly` re-rolls the previous two hours at
    :07 each hour.
  - `conversation_metrics_backfill(n)` covers up to 720 past hours.
  - Migration `20260923140000_vtid_04371_conversation_metrics_hourly.sql`
    was applied live, as the Drift Check requires. 168 hours were backfilled
    in 1.3 s. The heaviest query (the 24 h opener-repeat join) measured
    3.4 ms.
- **New read model `services/conversation/conversation-metrics.ts`** (pure
  functions):
  - window summary;
  - gap-filled hourly series;
  - learning-job health;
  - narrative freshness.

  Window percentiles are the sample-weighted mean of the hourly values and
  are labelled `approx: true`, because exact window percentiles cannot be
  recovered from hourly ones.
- **Three admin-only endpoints** on the existing conversation-hub router.
  - They read only the rollup, plus `automation_runs` and the
    narrative timestamp.
  - The narrative text itself is never selected.
  - Endpoints:
    - `GET /api/v1/admin/conversation/metrics/summary`
    - `GET /api/v1/admin/conversation/metrics/series`
    - `GET /api/v1/admin/conversation/metrics/learning`
- **Command Hub:**
  - Conversation → Monitor gains a performance dashboard above the existing
    decisions feed, with a 24 h / 7 d / 30 d window. It shows:
    - speed;
    - sessions;
    - reliability, with errors by kind;
    - openers and the repeat rate;
    - offers;
    - languages.
  - The Assistant → Metrics placeholder is replaced by a learning-health view:
    - what each session leaves behind;
    - profile-narrative freshness;
    - the nightly jobs AP-0906..AP-0913, flagged stale after 36 h.
  - Styling is class-based (the CSP gate is clean), and the `?v=` value is
    bumped.

## Needs owner approval

- **Tab reuse.** Plan v1 marks reusing these two tabs as an owner decision.
  - Monitor keeps its decisions feed; the dashboard is added above it.
  - Metrics was an empty placeholder.
- Both can be moved to new tabs without changing the API.

## What the first live rollup already shows (7 days, read-only)

- **Context wait timed out:** 162 of 177 turn-0 context waits (91.5%). This
  matches `ORB_CONTEXT_READY_GATE_TIMEOUT_MS=300`.
- **Missing stop events:** 219 of 477 started sessions (45.9%) have a
  `vtid.live.session.stop` event, and 15 stops are duplicates.
- **Silent sessions:** 73 of 219 stopped sessions (33.3%) produced no model
  audio.
- **Opener repeats:** 256 of 330 greetings (78%) repeated the same opener the
  same user heard in another session within 24 h.
- **First model audio:**

  | Transport | p50 | p90 |
  |---|---|---|
  | All | about 3.9 s | about 5.4 s |
  | SSE | about 3.3 s | about 4.1 s |
  | WebSocket | about 6.9 s | about 9.3 s |

- **Nightly learning jobs:** none of the eight has run since 2026-07-12 (all
  stale). 0 of the 26 profile narratives are fresh.
- **Upstream errors:** 77 of 84 are still reported as `code:nova_validation`
  with no `failure_kind`, because VTID-04369 is not deployed yet.

Each of these is a finding for its own VTID, not something this VTID changes.

## Acceptance criteria

AC-1: The rollup function is idempotent per hour, reads only topic-filtered oasis_events windows plus memory_facts, and is service-role only (applied live; backfill and cron verified by query).
TEST: services/gateway/test/services/conversation/vtid-04371-conversation-metrics.test.ts

AC-2: The summary sums counts across hours, derives stop coverage, silent rate, opener repeat rate and offer acceptance, splits errors by failure kind, and returns null (never NaN) on an empty window.
TEST: services/gateway/test/services/conversation/vtid-04371-conversation-metrics.test.ts

AC-3: Window percentiles are sample-weighted and labelled approximate; the hourly series is gap-filled oldest first.
TEST: services/gateway/test/services/conversation/vtid-04371-conversation-metrics.test.ts

AC-4: The three endpoints are admin-gated, clamp the window, validate the metric name, answer 503 without a DB and 500 JSON on a read error, and degrade per source on the learning view.
TEST: services/gateway/test/routes/vtid-04371-conversation-metrics-routes.test.ts

AC-5: The metrics handlers never read oasis_events, and the narrative read selects only the timestamp.
TEST: services/gateway/test/services/conversation/vtid-04371-conversation-metrics.test.ts

AC-6: Monitor and Assistant → Metrics render the dashboards from the real summarizers at 1400×900 and 390×844, with no page errors, no horizontal overflow, and a working window picker.
UI: docs/validation/VTID-04371/outputs/monitor-desktop.png, docs/validation/VTID-04371/outputs/learning-desktop.png, docs/validation/VTID-04371/outputs/monitor-mobile.png, docs/validation/VTID-04371/outputs/learning-mobile.png, docs/validation/VTID-04371/outputs/shoot-report.json

AC-7: No regression in the conversation-hub routes, the Command Hub suites, or the ownership and path guards.
TEST: services/gateway/test/routes/conversation-hub.test.ts, services/gateway/test/command-hub, services/gateway/test/scripts/command-hub-ownership-guard.test.ts

AC-8 (post-deploy, staging): `GET /api/v1/admin/conversation/metrics/summary` answers `401 application/json` anonymously and a real summary for an exafy_admin; `cron.job_run_details` shows `conversation-metrics-hourly` succeeding each hour.
CURL: curl -s -o /dev/null -w "%{http_code} %{content_type}" https://preview-aws-gateway.vitanaland.com/api/v1/admin/conversation/metrics/summary

## Not verified live

- No staging page load has read the new endpoints; they are not deployed yet
  (AC-8).
- The dashboards were verified on a local harness. It serves the working-tree
  statics, and the endpoints are backed by the real summarizers over rows read
  read-only from the live rollup.
