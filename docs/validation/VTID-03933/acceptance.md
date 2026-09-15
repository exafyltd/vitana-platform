# VTID-03933 — Fix `guessAreaFromText()` ordering bug (Auth false-positive on "session")

Found while evaluating Command Hub Operator's real-world quality: a real
frontend task was submitted through the live Operator chat API
("build for the Command Hub Operator Console to be able to change the Task
or session title by double click...") and the resulting VTID (VTID-03931)
was auto-titled `"Auth: Feature: Inline title editing in the Command Hub"` —
mis-categorized as `Auth` when it is clearly a Command Hub/Operator feature.

## Root cause

`guessAreaFromText()` (`services/gateway/src/utils/task-title.ts`) walks an
ordered `[RegExp, SystemArea]` array and returns the FIRST matching area
(first-match-wins). `Auth` was checked 2nd (right after `ORB`), and its
keyword list includes the bare word `session` — a word that appears in a lot
of text that has nothing to do with authentication (e.g. "task or session
title"). The submitted text also contained `command hub` and `operator`,
both far more specific matches, but `Auth`'s `session` keyword won because
it was checked first.

## Fix

Reordered the keyword array in `guessAreaFromText()` so `Auth` is checked
**last**, after every other, more specific category has had a chance to
match. `ORB` stays first (already fairly disambiguated — `orb`, `voice`,
`audio`, `microphone` rarely collide with other areas). A genuine Auth-only
text (login/token/jwt/password/provision/bare "session" with no other
category keyword present) still correctly classifies as `Auth`, since it's
the only pattern that matches by the time the loop reaches it.

No other function in `task-title.ts` was touched — `validateTaskTitle()`,
`normalizeTaskTitle()`, `extractArea()`, `buildTitle()` are all unaffected
by this reordering (`SYSTEM_AREAS`/`AREA_LOOKUP` unchanged).

---

AC-1 — the exact reproduced live failure now classifies as `Command Hub`,
not `Auth`

TEST: `test/task-title.guess-area-ordering.test.ts` — "classifies the exact
reproduced live failure as Command Hub, not Auth"
Output: outputs/targeted-tests.txt

AC-2 — genuine Auth-only text (login/token/jwt/password/provision/bare
"session" with no other area keyword) still classifies as `Auth`

TEST: `test/task-title.guess-area-ordering.test.ts` — "still classifies
genuine Auth-only text as Auth (bare \"session\", no other area keyword)"
Output: outputs/targeted-tests.txt

AC-3 — a more specific area (OASIS, Operator, Pipeline) wins over "session"
appearing elsewhere in the same text

TEST: `test/task-title.guess-area-ordering.test.ts` — "lets a more specific
area win over \"session\" appearing elsewhere in the text"
Output: outputs/targeted-tests.txt

AC-4 — `ORB` keeps priority over `Auth` for voice/session text (ORB stays
first in the array, unchanged)

TEST: `test/task-title.guess-area-ordering.test.ts` — "ORB keeps priority
over Auth for voice/session text (ORB stays first)"
Output: outputs/targeted-tests.txt

AC-5 — the `Gateway` fallback default is unchanged for text matching no
keyword at all

TEST: `test/task-title.guess-area-ordering.test.ts` — "falls back to
Gateway when nothing matches, unchanged from before"
Output: outputs/targeted-tests.txt

AC-6 — no regression to the existing `extractTitle()` title-building tests
(`operator-service.ts`'s consumer of `guessAreaFromText()`)

TEST: `test/operator-service.extract-title.test.ts` (full file)
Output: outputs/targeted-tests.txt

AC-7 — mutation-verified: reverting `Auth` to its original 2nd-position
placement reproduces the exact live bug and fails 3 of the above tests

Verified manually: `git stash` (reverting the fix) → re-ran
`test/task-title.guess-area-ordering.test.ts` → 3/6 tests failed, including
the exact reproduced-failure assertion (AC-1) returning `Auth` instead of
`Command Hub`, and the "more specific area wins" assertions (AC-3) also
failing for OASIS/Operator/Pipeline. `git stash pop` restored the fix and
all 6 tests passed again. Not re-captured as a separate output file (ran
interactively); the full before/after console output is reproduced in this
PR's description.

AC-8 — no regression to the existing gateway test suite or type-checking

TEST: `npx jest` (full suite)
Output: outputs/full-suite.txt
TEST: `npx tsc --noEmit`
Output: outputs/tsc.txt
Note: both show the same 2 pre-existing, unrelated `tsc` errors already
documented in VTID-03927's evidence pack (`Cannot find module
'@aws-sdk/s3-request-presigner'` / `'@aws-sdk/client-cognito-identity-provider'`
— declared in `package.json`, missing from this session's local
`node_modules`). The full-suite run additionally shows 12 failed suites (11
"Test suite failed to run" from the same missing-module root cause,
cascading through different import chains, plus `test/intent-cover-service.test.ts`
which fails identically — confirmed via `git stash` against the unmodified
tree — for the same reason). Zero failures in any file this VTID touches
(`src/utils/task-title.ts`, `test/task-title.guess-area-ordering.test.ts`,
`test/operator-service.extract-title.test.ts`). CI's own `npm ci` in the
Build Gate step installs from the committed lockfile fresh, which does not
carry this local `node_modules` gap forward.
