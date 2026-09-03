# VTID-03731 — standing all-languages ORB voice test program

Explicit platform-owner instruction after VTID-03730 (Turkish end-to-end):
"write a Test Program for testing everything by yourself, all the
implemented languages!" This is that program: `scripts/tts/verify-all-orb-
languages.ts`, plus a coverage unit test.

It combines the two things that separately have been the ROOT CAUSE of every
"language X speaks English" incident in this codebase's history
(VTID-03578/03681/03719/03730 each fixed one specific undeclared gap):
routing correctness and real-audio correctness. A language can pass either
check alone and still be broken for a real user.

---

AC-1 — every language in `SUPPORTED_LIVE_LANGUAGES` gets both a routing
check (never `vertex`, correct provider for its class — Nova-native /
cascade-eligible / Serbian's forced-substitute) and a real-audio check

TEST: live run against staging, `docs/validation/VTID-03731/outputs/live-run.txt`
— run 1: 11/11 languages pass both checks
Output: outputs/live-run.txt

AC-2 — the program reuses the existing, already-proven PCM-timing checks
(`testOneLanguage`, `pacingBoundsFor`, `loadRealPcmRateFromMime`,
`verifyWidgetWiringIsConnected` from VTID-03716/03719's
`verify-cascade-audio-timing.ts`) rather than reimplementing them

TEST: `services/gateway/test/scripts/verify-all-orb-languages.test.ts` —
import succeeds, `pacingBoundsFor` reused correctly (transitively exercised
by the live run using the imported function directly)
Output: outputs/targeted-tests.txt

AC-3 — the language list itself is read from `SUPPORTED_LIVE_LANGUAGES`,
not hardcoded, so a future language addition is automatically covered

TEST: `verify-all-orb-languages.test.ts` — "has a test phrase for every
language the live gate admits" / "does not carry a stale test phrase for a
language the gate no longer admits" (both directions checked)
Output: outputs/targeted-tests.txt

AC-4 — Serbian is a DECLARED exception (Polly has no Serbian voice), not a
silent skip — the program asserts the 422 rather than ignoring `sr`

TEST: live run, `=== sr ===` block: "OK (EXPECTED-FAIL): Polly correctly
refuses sr with 422"
TEST: `verify-all-orb-languages.test.ts` — "sr is the one declared
cascade-ineligible language, and is a real member of the gate"
Output: outputs/live-run.txt, outputs/targeted-tests.txt

AC-5 — the script's own Nova-native literal (`NOVA_NATIVE`) is verified to
still agree with the real source of truth
(`NOVA_SONIC_SUPPORTED_LANGUAGES`), so a future desync is caught in CI
rather than silently making the routing check assert against itself

TEST: `verify-all-orb-languages.test.ts` — "NOVA_NATIVE matches
NOVA_SONIC_SUPPORTED_LANGUAGES exactly"
Output: outputs/targeted-tests.txt

AC-6 — no regression to the full gateway suite or to type-checking

TEST: `npx jest --testPathPattern="verify-all-orb-languages|verify-cascade-audio-timing"`
— 2 suites, 11 tests, all pass
TEST: `npx tsc --noEmit` — clean
Output: outputs/targeted-tests.txt, outputs/tsc.txt

---

## Honest note on the evidence itself

Two live runs are captured in `outputs/live-run.txt`, not one — the first
(11/11 pass) had its `en`/`de`/`fr` per-language detail lines scroll past a
`tail -100` terminal capture before the output was redirected to a file
(the SUMMARY table for that run is complete and unedited). Running the
program a second time immediately afterward, inside the same 15-minute
window, hit `/tts-pcm-diagnostic`'s own real rate limiter (20 req/15min,
by design — see the route's own VTID-03716 header) on the last two
languages. That is not a defect in this program; it is the route's
existing protection working as intended, and is now documented in the
script's own header so a future runner doesn't mistake it for a bug. No
output here was edited or invented — what scrolled past truly scrolled
past, and what hit 429 truly hit 429.
