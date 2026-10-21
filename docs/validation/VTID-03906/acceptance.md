# VTID-03906 — Operator popup: scroll-jump/flicker fix

Companion work in the same PR, own VTIDs, own acceptance criteria below:
**VTID-03907** (voice dictation mic button), **VTID-03908** (fullscreen/
restore toggle on the overlay header).

## Report

User report (verbatim, from the Command Hub): "i opened the operator and
the scroll jumped out of nowhere to the top of the conversation and screen
flickering. this is a bug. fix this." Also asked for voice dictation (mic
button beside the chat input) and a fullscreen/restore toggle beside the
existing X close button.

Root causes found by reading the real source in
`services/gateway/src/frontend/command-hub/app.js`, not guessed:

1. **Scroll jump.** The `.chat-messages` scroll-restore block inside
   `_renderAppCore()`'s render cycle was gated on
   `state.isOperatorOpen && state.operatorActiveTab === 'chat' &&
   !savedChatFocus` — so on ANY full re-render while the chat textarea had
   focus (the normal reading/typing state), scroll restoration was skipped
   entirely, leaving the freshly rebuilt `.chat-messages` container at
   `scrollTop = 0`. The textarea's own focus/cursor restore
   (`VTID-0526-E`) is a separate, unconditional block touching a different
   element — the two never needed to be mutually exclusive.
2. **Flicker.** `state._actionRequiredTimer` (a 30s `setInterval` set up by
   the Overview tab) calls `fetchActionRequired(true)`, which unconditionally
   ends with `renderApp()` — a full `root.innerHTML=''` + DOM rebuild —
   whenever `state.activeModule === 'overview' && state.activeTab ===
   'system-overview'`. `state.isOperatorOpen` is an independent overlay
   flag: opening the Operator popup on top of the Overview tab does not
   change `activeModule`/`activeTab`, so this timer kept firing every 30s
   and tearing down/rebuilding the entire DOM (Operator popup included)
   with no user action — "flickering...out of nowhere".

## Acceptance Criteria

AC-1 — the `.chat-messages` scroll-restore block in `_renderAppCore()` no
longer requires `!savedChatFocus`; it restores scroll (to bottom if the
user was near bottom, else preserving `scrollTop`) on every full re-render
while the Operator chat tab is open, regardless of textarea focus.

TEST: `outputs/jest-new-suite.txt` —
`test/vtid-03906-08-operator-scroll-mic-fullscreen.test.ts`, "VTID-03906"
block, cases 1-3 (gate no longer requires `!savedChatFocus`, still reads
`savedChatScroll`, the independent textarea-focus-restore block is
untouched).

AC-2 — `_actionRequiredTimer`'s 30s poll skips entirely
(`!state.isOperatorOpen` added to its existing condition) while the
Operator popup is open, so it can no longer force an unprompted full
re-render on top of an open popup.

TEST: `outputs/jest-new-suite.txt` — same block, case 4.

UI: not independently screenshotted — this session has no live
authenticated Command Hub browser session to reach (same limitation as the
prior PR in this repo, VTID-03896). Verified via `node --check app.js`
(syntax), the source-text regression tests above (which pin the exact
gate conditions removed/added), and manual review against the existing
render/scroll-preservation pattern this file already establishes for
`savedChatFocus`/`savedSpecFocus`.

## VTID-03907 — voice dictation mic button

User request (verbatim): "Then i need voice dictation. implement mic
beside the chat text input field, so i can use voice instead of text."

AC-3 — a mic button (`.chat-mic-btn`) sits in the Operator chat input row,
between the textarea and the send button, using the browser's native Web
Speech API (`SpeechRecognition`/`webkitSpeechRecognition`) — no new
backend route, no new dependency. Disabled with an explanatory `title`
when the API is unsupported. While recording, interim + final transcripts
stream directly into `state.chatInputValue` and the live textarea value
without going through `renderApp()` (a full re-render per partial speech
result would reproduce the exact disruption VTID-03906 fixed for this same
popup). Clicking again, sending the message, or closing the Operator popup
(X button or backdrop click) stops any in-progress dictation.

TEST: `outputs/jest-new-suite.txt` — "VTID-03907" block (API-support check,
no-renderApp-per-result, active/inactive state clearing on end/error, the
button wired into the input row and disabled when unsupported, dictation
stopped by send/close, `.chat-mic-btn`/`.chat-mic-btn--active` CSS exists).

UI: not independently screenshotted (same session limitation as AC-1/2
above). Verified via source-text regression tests and manual review of the
DOM/class wiring against the existing `.chat-attach-btn` icon-button
pattern in the same input row.

## VTID-03908 — fullscreen/restore toggle on the Operator popup

User request (verbatim): "the add the icon for making the operator popup
full screen beside the x button and also an icon to shrink back to
original popup screen. and keep the x button to close the operator screen
as is."

AC-4 — a fullscreen icon button sits beside the existing X close button in
the Operator overlay header (both wrapped in a new `.overlay-header-actions`
flex row, so the header's existing `justify-content: space-between` still
splits the title block from this action group). Clicking it toggles
`state.isOperatorFullscreen` and re-renders; the overlay panel gets the
`.operator-overlay--fullscreen` CSS modifier class (100vw/100vh, no
max-width/border-radius) when true, and the original `.operator-overlay`
sizing (70vw/min 600px/max 1000px/80vh) otherwise. The icon itself swaps
between an "expand" and a "restore" glyph depending on state.

TEST: `outputs/jest-new-suite.txt` — "VTID-03908" block (fullscreen class
applied conditionally, both buttons live inside `overlay-header-actions`,
the fullscreen button toggles state + re-renders, the CSS modifier class
exists with the expected dimensions).

AC-5 — the X close button's own behavior is unchanged: it still only sets
`state.isOperatorOpen = false` (plus the pre-existing
`stopActiveExecutionsPolling()` and, new in this PR, dictation cleanup) —
it never reads or writes `state.isOperatorFullscreen`.

TEST: `outputs/jest-new-suite.txt` — "VTID-03908" block (fullscreen class
applied conditionally, both buttons live inside `overlay-header-actions`,
the fullscreen button toggles state + re-renders, the close button's own
onclick body contains no reference to `isOperatorFullscreen`, initial state
defaults to `false`, the CSS modifier class exists with the expected
dimensions).

UI: not independently screenshotted (same session limitation as above).
Verified via source-text regression tests and manual review of the
header's existing two-child flex layout, which still holds with
`headerActions` as the second child in place of the old bare `closeBtn`.

## OASIS impact

OASIS_IMPACT: no — all three fixes are client-side rendering/DOM/UI
changes in the Command Hub frontend only; no new server-side state
transition or OASIS event is introduced.
