# VTID-04419 — Conversation rebuild WS-1.7: brain inspector in the Command Hub

This is Plan v1 (Conversation Intelligence Rebuild), Phase 1, workstream WS-1.7.
It ships in PR #3614 as a companion to VTID-04339.

## What it does

For one ORB voice session, Conversation → Simulator and Conversation → Journey Context now show:

- **Context:**
  - the builder the session started on (brain / legacy / lesson) and any brain failure;
  - the bootstrap size;
  - what the packer kept, shortened and dropped (VTID-04393);
  - whether the stream-open gate timed out, and the context the setup actually carried;
  - whether the stored snapshot filled in (VTID-04399);
  - any reconnect rebuilds (VTID-04414).
- **Decision:** each opening decision, with opener, register, bucket, next step and screen.
- **Tools, errors, outcome:**
  - the tool catalog trim;
  - errors, including `watchdog_fired`;
  - first speech, and reply speed per user turn;
  - how the session ended, and whether it was finalized.
- **Timeline:** every recorded event, relative to the session start.

The session list is filtered by the user id already entered in each tab.

## How it reads, and what it never does

- **Two admin-only endpoints** (`requireAuth` + `requireExafyAdmin`):
  - `GET /api/v1/admin/conversation/sessions?hours=&user_id=&limit=` lists recent session starts.
  - `GET /api/v1/admin/conversation/sessions/:sessionId/brain` summarizes one session.
- **Every read is bounded by topic and a time window**, which the `(topic, created_at DESC)` index serves as a range scan. `EXPLAIN (ANALYZE)` on a 6-hour window: 20 shared buffers, 0.2 ms. The per-session read covers at most 2 h after the start and 800 events. No unbounded scan of `oasis_events` (the VTID-03980 shape).
- **The start event carries the user's email and user agent; the inspector never returns them.**
- **Inputs are validated:** a session id matches `[A-Za-z0-9_-]{4,120}`, a user id must be a UUID.
- **One small write-side change:** the session-start `orb.live.context.bootstrap` event now also carries `builder`, `brain_error` and `chars`.

## What the first real session showed (staging, 2026-09-22, read-only)

The harness fixture is one real staging session, sanitized (`outputs/session-events-sanitized.json`). The inspector made these visible at a glance:

- the setup carried **0 chars** of context after a 300 ms gate timeout (the VTID-04399 case);
- **reply speed was 12.7 s and 16.7 s** on turns 1 and 2;
- a **`watchdog_fired` (`forwarding_no_ack`)** ended the conversation;
- the stop event had **no reason**, and the session was **not finalized**.

The last two are follow-ups. That session predates VTID-04353's finalize on this branch.

## Acceptance criteria

AC-1: The summarizer reports context (builder, packing, gate, setup, snapshot, reconnect rebuilds), decision, tools, errors, outcome (incl. per-turn reply speed and a stop without a reason) and an ordered timeline, and never returns the email or user agent.
TEST: services/gateway/test/services/conversation/vtid-04419-session-brain-inspector.test.ts

AC-2: Session ids and user ids are validated; the list read and the session read are bounded by topic and time window and filter by session/user; a missing start event returns not-found without a second read.
TEST: services/gateway/test/services/conversation/vtid-04419-session-brain-inspector.test.ts

AC-3: Both routes are admin-only; the bootstrap event names the builder; the inspector is mounted in Simulator and Journey Context; its code is class-styled only and its CSS rules are top-level.
TEST: services/gateway/test/services/conversation/vtid-04419-session-brain-inspector.test.ts

AC-4: The inspector renders at 1400×900 and 390×844 in both tabs against the local harness: session list → click → inspector, no page errors, no horizontal overflow.
UI: docs/validation/VTID-04419/outputs/simulator-desktop.png, docs/validation/VTID-04419/outputs/journey-context-mobile-full.png, docs/validation/VTID-04419/outputs/shoot-report.json

AC-5: No regression in the conversation, Command Hub, ORB and script suites; tsc clean; CSP gate clean.
TEST: services/gateway/test/services/conversation, services/gateway/test/command-hub

AC-6 (post-deploy, staging): both endpoints return 401 JSON anonymously; an admin session lists recent sessions and inspects one.
CURL: curl -s -o /dev/null -w "%{http_code} %{content_type}" https://preview-aws-gateway.vitanaland.com/api/v1/admin/conversation/sessions
