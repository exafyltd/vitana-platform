# VTID-03944 — Fix Operator popup flickering (4 more unguarded background pollers)

Reported live: *"why is the operator popup screen flickering??? its annoying"*

## Root cause

`renderApp()` (`services/gateway/src/frontend/command-hub/app.js`) does a
full `root.innerHTML = ''` and rebuilds the entire Command Hub DOM on every
call. The Operator Console popup is a global overlay appended inside that
same rebuild (`if (state.isOperatorOpen) root.appendChild(renderOperatorOverlay());`),
sitting on top of whatever tab/drawer is mounted underneath it.

This codebase has already fixed this exact bug class twice:
- **VTID-0526-E**: the SSE ticker event handler called a full `renderApp()`
  on every event even while the Operator chat tab was active.
- **VTID-03906**: the Overview tab's `_actionRequiredTimer` (30s) kept
  calling a full `renderApp()` while mounted underneath the popup.

Auditing every `setInterval` in the file found **four more surviving
instances**, none checking `state.isOperatorOpen` before firing a
`renderApp()`-triggering fetch:

1. `state.executionStatusPollInterval` (5s) — polls while a task's
   execution-status drawer is open. The tightest interval of the four, so
   the most visibly "annoying" contributor when a task drawer and the
   Operator popup are open at the same time.
2. `state.devAutopilot.pollerId` (10s) — Dev Autopilot tab.
3. `state.autonomyPulse.pollerId` (30s) — Autonomy Pulse tab.
4. `state.autonomyTrace.pollerId` (30s) — Autonomy Trace tab.

Each of the three tab-scoped pollers only checked `state.currentTab`/
`state.currentModuleKey`, never `state.isOperatorOpen` — so opening the
Operator popup while any of those tabs (or, for #1, a task execution drawer)
was mounted underneath left the popup silently tearing down and rebuilding
every 5-30 seconds, unprompted by any user action.

## Fix

Added `if (state.isOperatorOpen) return;` as the first check inside each of
the 4 `setInterval` callbacks, before the `renderApp()`-triggering fetch —
the identical remedy pattern VTID-03906 already established for
`_actionRequiredTimer`. Polling itself is not torn down; only the
render-triggering fetch for that tick is skipped while the popup is open, so
state resumes correctly once it closes.

Confirmed NOT part of this bug (no fix needed, checked and ruled out):
`cicdHealthPollInterval`, `overviewDashboardRefreshInterval` (both do a
targeted/silent update, not a full render), `vh.pollingTimer`/
`_vhExecPollTimer` (targeted `replaceChild()`), `activeExecutionsPollInterval`
(never calls `renderApp()` at all — unrelated CI/CD ticker feature).

---

AC-1 — `executionStatusPollInterval` (5s) skips its tick while the Operator
popup is open, without stopping the polling itself

TEST: `test/vtid-03944-operator-popup-flicker-pollers.test.ts` —
"executionStatusPollInterval (5s) skips its tick while the Operator popup is
open"
Output: outputs/targeted-tests.txt

AC-2 — `devAutopilot.pollerId` (10s) skips its tick while the Operator popup
is open

TEST: `test/vtid-03944-operator-popup-flicker-pollers.test.ts` —
"devAutopilot.pollerId (10s) skips its tick while the Operator popup is open"
Output: outputs/targeted-tests.txt

AC-3 — `autonomyPulse.pollerId` (30s) skips its tick while the Operator
popup is open

TEST: `test/vtid-03944-operator-popup-flicker-pollers.test.ts` —
"autonomyPulse.pollerId (30s) skips its tick while the Operator popup is
open"
Output: outputs/targeted-tests.txt

AC-4 — `autonomyTrace.pollerId` (30s) skips its tick while the Operator
popup is open

TEST: `test/vtid-03944-operator-popup-flicker-pollers.test.ts` —
"autonomyTrace.pollerId (30s) skips its tick while the Operator popup is
open"
Output: outputs/targeted-tests.txt

AC-5 — no regression to the existing VTID-03906/0526-E operator-popup
regression suite

TEST: `test/vtid-03906-08-operator-scroll-mic-fullscreen.test.ts` (full file)
Output: outputs/targeted-tests.txt

AC-6 — mutation-verified: reverting the fix reproduces the exact bug shape
(no `isOperatorOpen` guard in the relevant poller body) and fails all 5 new
tests

TEST: manual mutation check — `git stash` (reverting the fix) → re-ran
`test/vtid-03944-operator-popup-flicker-pollers.test.ts` → 5/5 tests failed.
`git stash pop` restored the fix and all 5 tests passed again.

AC-7 — no regression to the existing gateway test suite or type-checking

TEST: `npx jest --runInBand` (full suite)
Output: outputs/full-suite.txt
TEST: `npx tsc --noEmit`
Output: outputs/tsc.txt
Note: both show the same 12 pre-existing failing suites / 2 pre-existing
`tsc` errors already documented in this session's own VTID-03927/03933/
03934/03937 evidence packs (missing `@aws-sdk` sub-packages in local
`node_modules`, declared in `package.json`, not referenced by any file this
VTID touches). Zero failures in `app.js` or the new test file. CI's own
`npm ci` in the Build Gate installs from the committed lockfile fresh, which
does not carry this local `node_modules` gap forward.
