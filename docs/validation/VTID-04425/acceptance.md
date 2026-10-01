# VTID-04425 — Conversation rebuild WS-3.3: screen updates during the conversation

This is Plan v1 (Conversation Intelligence Rebuild), Phase 3, workstream WS-3.3. It ships in two repos:

- `exafyltd/vitana-platform` PR #3614, as a companion to VTID-04339;
- `exafyltd/vitana-v1` PR #1135.

## Why

The ORB widget reported the screen only in the session start payload. When the user navigated by hand mid-conversation, the gateway never heard about it: `session.current_route` moved only when Vitana navigated herself. So `get_current_screen`, the navigator and the brain answered about a screen the user had already left.

## Change

### Gateway (`orb/live/session/context-update.ts`)

- **`sanitizeContextUpdate`** validates the untrusted body:
  - the route must be an app path (`/…`, not `//`, no whitespace, quotes or angle brackets, at most 300 chars);
  - at most 5 trail routes;
  - a title of at most 120 chars;
  - at most 12 app-state keys matching `^[a-z][a-z0-9_]{0,39}$`, with primitive values only and strings at most 120 chars;
  - a boolean mobile flag.

  Unknown fields are dropped.
- **`applyContextUpdate`** updates `current_route`, the trail, `clientContext.isMobile` and a new in-memory `screenContext` (title and app state).
  - The trail is kept newest first and deduplicated; the host's own trail wins.
  - Screen state resets on a new screen.
  - A duplicate update changes nothing.
  - Counters are kept on the session.
- **`handleContextUpdateMessage`** is the one entry point both transports use:
  - WebSocket: a `context_update` frame;
  - SSE: `POST /api/v1/orb/live/stream/send` with `type: 'context_update'`.

  A route change emits one `orb.live.diag` `context_update` diagnostic, at most 20 per session.
- **Readers:**
  - `get_current_screen` returns the host's screen state (`screen_state`) alongside the catalog entry;
  - `SessionContext` carries `screenContext` (the shape test now expects 13 keys, deliberately);
  - `conversation.session.finalized` gains `context_updates` counters when any arrived.
- **Nothing is injected into the model stream.** The VTID-04424 probe showed that mid-session SYSTEM text fails the Nova stream, and that USER text is either ignored or answered unprompted. The tool list stays fixed for the stream.

### Widget (`orb-widget.js`, `?v=` bumped)

- `updateContext` now accepts `screen_title`, `app_state` and `is_mobile`, and schedules a `context_update`.
- The update is debounced (250 ms) and deduplicated by content, and is sent only while a session is active.
- It goes over the WebSocket, or over the SSE send endpoint. The dedupe key resets at each session start.

### Frontend (`exafyltd/vitana-v1` #1135)

- `useOrbVoiceWidget` adds the page title and view params (`tab`, `view`, `section`, `step`, `mode`, plus the UI language) to the existing route-change `updateContext` call.
- The params pass only when they match a strict token shape, never free text.
- It also re-emits on query-string changes.

## Acceptance

AC-1: Untrusted bodies are validated field by field; unknown fields, non-app routes and oversize values are dropped; an empty result is refused.
TEST: services/gateway/test/orb/live/session/vtid-04425-context-update.test.ts

AC-2: A route change moves the session and keeps the trail newest first and deduplicated. Duplicates change nothing, the host trail wins, screen state resets on a new screen, and the mobile flag is updated.
TEST: services/gateway/test/orb/live/session/vtid-04425-context-update.test.ts

AC-3: Route-change diagnostics are bounded at 20 per session, and a failing emitter never breaks the update.
TEST: services/gateway/test/orb/live/session/vtid-04425-context-update.test.ts

AC-4: `get_current_screen` and the session context carry the host's screen state; the finalized event carries the counters.
TEST: services/gateway/test/orb/live/session/vtid-04425-context-update.test.ts

AC-5: Both transports use the one shared handler; the widget sends a debounced, deduplicated update only during a session, over WS or SSE.
TEST: services/gateway/test/orb/live/session/vtid-04425-context-update.test.ts

AC-6: `SessionContext` gains exactly one key, `screenContext`.
TEST: services/gateway/test/orb/live/session/session-context.test.ts

## Not verified live

Staging cannot place ECS tasks yet. After deploy, open a voice session on `preview-aws.vitanaland.com`, tap to another screen and ask "where am I?". Expected:

- an `orb.live.diag` `context_update` diagnostic with the new route;
- the answer names the new screen;
- the `conversation.session.finalized` payload carries `context_updates`.
