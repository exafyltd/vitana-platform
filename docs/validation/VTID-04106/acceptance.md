# VTID-04106 — Acceptance

Reported live, with two screenshots: "I have entered a fresh message into
the chat inbox uh, input field, but the cursor, instead of jumping to the
latest input I just entered, the cursor stay with the oldest message." The
composer showed "Sending..." with the newly-sent message only partially
visible at the bottom edge, while the visible scroll position stayed on
older history the user had been reading.

## Root cause

`_renderAppCore()`'s VTID-0539 scroll-anchor logic decides whether a
`.chat-messages` re-render should jump to the bottom purely from
`savedChatScroll.wasNearBottom` — computed from the scroll position at the
START of that render, before it knows why the render happened. It has no
way to distinguish a render triggered by the user's own `sendChatMessage()`
call from a passive background update (an SSE `step` event from
`followOperatorExecution` — more frequent since VTID-04104 reattaches
follows on load/switch — or an unrelated ticker/poll re-render).

The existing VTID-0526-D explicit force-scroll `requestAnimationFrame`
calls in `sendChatMessage()` raced against the anchor logic's own rAF and
against any background render's rAF firing around the same time; when a
background render's stale `wasNearBottom: false` snapshot won that race,
the intentional scroll got silently overridden.

## Fix

New authoritative `state.chatStickToBottom` flag (default `true`):

1. `sendChatMessage()` sets it `true` unconditionally at the top of every
   send, before any message is pushed — regardless of where the user was
   scrolled beforehand.
2. The VTID-0539 anchor check in `_renderAppCore()` now scrolls to bottom
   on `savedChatScroll.wasNearBottom || state.chatStickToBottom` instead of
   `wasNearBottom` alone — an intentional send always wins the anchor
   decision, independent of any concurrent background render's own
   snapshot.
3. A new `scroll` listener on the `.chat-messages` element (attached in
   `renderOperatorChat()`, right after the element is created) keeps the
   flag in sync with the user's own manual scrolling, at the same 80px
   distance-from-bottom threshold `wasNearBottom` already uses — so
   scrolling up to read history sets it `false` again, and scrolling back
   down re-arms it without needing to send a message first.

## Acceptance criteria

AC-1: `state.chatStickToBottom` exists on the state object, defaulting
`true`.
TEST: `services/gateway/test/vtid-04106-operator-chat-stick-to-bottom.test.ts`
— "declares state.chatStickToBottom, defaulting true".

AC-2: every send re-arms the flag before any message is pushed to
`state.chatMessages`.
TEST: same file — "sendChatMessage() re-arms chatStickToBottom on every
send, before any message push".

AC-3: the VTID-0539 anchor decision scrolls to bottom on
`wasNearBottom || chatStickToBottom`.
TEST: same file — "the VTID-0539 anchor logic in _renderAppCore() scrolls
to bottom when EITHER wasNearBottom OR chatStickToBottom is true".

AC-4: a scroll listener on `.chat-messages` keeps the flag in sync with the
user's manual scrolling, using the same 80px threshold as `wasNearBottom`.
TEST: same file — "the .chat-messages scroll listener keeps
chatStickToBottom in sync with the user's own manual scrolling, using the
same 80px threshold as wasNearBottom".

AC-5: the listener is attached before any message is rendered, so it is
live for every render of the panel, not just the first.
TEST: same file — "the scroll listener is attached to the messages
container before any message rendering, so it is live for every render".

## Verification

`node --check` clean on `app.js`. `tsc --noEmit` clean across the gateway
service. Targeted suites: 3/3 suites, 21/21 tests passing (the new suite,
plus the pre-existing `vtid-04104-operator-follow-persist.test.ts` and
`vtid-03947-message-copy-timestamp.test.ts` — both touch the same
`renderOperatorChat()`/`sendChatMessage()` functions and stayed green
unmodified, confirming this fix is additive, not a rewrite of either).

Mutation-verified: stashed all three source edits (`app.js`, `index.html`,
`scripts/ci/command-hub-ownership-guard.js`), re-ran the new suite — all 6
tests failed with the exact missing wiring (no `chatStickToBottom` flag, no
scroll listener, stale cache-bust/allowlist) — then restored the stash and
confirmed green again.

## Not done here

- Not yet re-verified against a live staging session — the next real
  signal is scrolling up to read older Operator Console history, sending a
  new message, and confirming the view jumps to show it, on both a
  same-tab send and a follow-panel-driven background render happening
  concurrently.
- No Playwright screenshot pass: this is a scroll-behavior fix to existing,
  already-visually-verified markup (the `.chat-messages` container and its
  bubbles) — no markup or CSS changed, only when auto-scroll fires.
