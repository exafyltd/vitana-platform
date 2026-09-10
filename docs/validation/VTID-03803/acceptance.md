# VTID-03803 — Spanish/French ORB voice answering in English

User-reported live: "Spanish and French general Orb communication is in
English. Investigate why and fix it! All other languages are correct!"

## Root cause

`es` and `fr` were listed in `NOVA_SONIC_SUPPORTED_LANGUAGES`
(`en/de/fr/es`), which structurally excludes them from the
Transcribe→Bedrock→Polly cascade: `tryCascadeRescue()`
(`upstream-provider-selector.ts`) returns `null` unconditionally whenever
`languageBlocked` is false, and `languageBlocked` is computed as
`ctx.nova.languageSupported !== true` — i.e. a language Nova is *declared*
to support can never be cascade-rescued, by design (`evaluateCascadeEligibility`:
"If Nova speaks it, the cascade is refused even though it would technically
work"). So every `es`/`fr` session went straight to raw Nova, with no
alternate path.

This is the identical mechanism already found and fixed once before, for
Portuguese (VTID-03704): AWS's own Nova 2 Sonic documentation lists French
and Spanish as supported (same table that lists Portuguese), and the
system instruction already correctly composes "Respond ONLY in
French"/"Respond ONLY in Spanish" (`languageNames` in
`live-system-instruction.ts` has both, correctly, ruling out a
missing-language-name-map bug). Despite both of those being correct, Nova
does not reliably generate the requested language for these codes — the
same gap the `pt` fix's own comment names: "Accepting a voice id is not
generating [the language]." There is no narrower fix available: Nova
exposes no per-language reliability setting, only the binary of routing a
session through it or not.

## Fix

Removed `fr`/`es` from `NOVA_SONIC_SUPPORTED_LANGUAGES`
(`nova-sonic-config.ts`), mirroring the proven `pt` precedent exactly. Both
now fall through to the same cascade `pt`/`tr`/`pl`/`ru`/`ar`/`zh` already
use — Transcribe has `fr-FR`/`es-ES`, Polly has `Lea`/`Lucia`, so both are
cascade-eligible with no downstream gap to fill first. Their `NOVA_VOICES`
entries (`ambre`/`lupe`) are deliberately KEPT (not deleted) — same as
`pt` kept `carolina` — since routing and voice-id are separate questions
and emptying a voice entry on reroute has previously caused its own
regression (VTID-03704's own retrospective).

Stale comments referencing the old `en/de/fr/es/pt` / `en/de/fr/es` sets
were corrected in `cascaded-config.ts`, `nova-sonic-voice.ts`, and the
standing live-verification script `scripts/tts/verify-all-orb-languages.ts`
(`NOVA_NATIVE`, deliberately duplicated there rather than imported, so it
independently cross-checks the routing table rather than trusting it).

## ⚠️ Not fully closed by this change alone — read before assuming the report is resolved

This fix is **necessary but not sufficient** today. Confirmed via a
read-only production query (`oasis_events`, Supabase MCP `execute_sql`,
SELECT only — no writes, per the absolute production-write ban):

- **Zero** `cascaded_language_rescue` events in the last 30 days — the
  cascade has never fired in production.
- The cascade was deliberately left **OFF** after a 2026-08-24 emergency
  rollback (a widget PCM sample-rate bug causing "chipmunk" cascade audio
  for ru/pl/ar/zh/tr sessions, VTID-03683/03703). The mime-threading fix
  for that bug (VTID-03711/03715) *did* ship to production the same day,
  but the follow-up dispatch to re-enable `ORB_CASCADED_VOICE_ENABLED` was
  deliberately deferred and — per this session's own open task list
  ("PUBLISH the voice chain to production, THEN re-enable the cascade" —
  still pending) — has not happened since.

`tryCascadeRescue()` returns `null` whenever `ORB_CASCADED_VOICE_ENABLED`
is not exactly `'true'`, so **until that flag is deliberately re-enabled on
the live task definition, `fr`/`es` sessions still transit raw Nova**
(via `nova_forced_vertex_unavailable`, byte-for-byte the pre-fix behavior)
— unchanged from today, same as `pt`/`pl`/`ru`/`ar`/`zh`/`tr` right now.
This PR ships the correct, proven code-level fix and makes `fr`/`es`
cascade-eligible the moment that flag flips; it does not itself flip that
flag, since doing so is a separate, higher-risk, already-pending
production decision (re-enabling the cascade for six other languages too,
with an incident history) that should not be bundled silently into a
report-driven code fix.

---

AC-1 — `fr`/`es` are no longer classified as Nova-native

TEST: `test/orb/live/upstream/nova-sonic-config.test.ts` — "accepts en/de
incl. regional tags" / "rejects everything else, including fr/es
(VTID-03803)"
Output: outputs/targeted-tests.txt

AC-2 — `fr`/`es` are now cascade-eligible, with the correct Transcribe
language codes, and no other language's eligibility changes

TEST: `test/orb/live/upstream/cascaded-voice.test.ts` — "takes exactly the
languages Nova cannot speak AND both AWS services can" (new fr/es
assertions + `listCascadeLanguages()` now includes them)
TEST: `test/orb/live/upstream/cascade-health-payload.test.ts` —
"reports the languages the cascade rescues, with their Transcribe codes"
(fr/es now `cascade:fr-FR`/`cascade:es-ES`) / "reports Nova-native
languages as refused for that reason" (narrowed to en/de only)
Output: outputs/targeted-tests.txt

AC-3 — the invariant-style routing-policy suite (written to hold for ANY
language set, not hardcoded per-language) confirms fr/es land on the
cascade and keep a real, non-substituted Nova voice entry for when they do
still transit Nova pre-flag-flip

TEST: `test/orb/live/voice/voice-routing-policy.test.ts` — unmodified,
passes because it is written as an invariant over the language sets
Output: outputs/targeted-tests.txt

AC-4 — the standing live-verification script's duplicated `NOVA_NATIVE`
literal still agrees with the real routing table (the one place a
future desync between the two would be caught in CI, not just live)

TEST: `test/scripts/verify-all-orb-languages.test.ts` — "NOVA_NATIVE
matches NOVA_SONIC_SUPPORTED_LANGUAGES exactly"
Output: outputs/targeted-tests.txt

AC-5 — no regression to the existing gateway test suite or type-checking

TEST: `npx jest` (full suite)
Output: outputs/full-suite.txt
TEST: `npx tsc --noEmit`
Output: outputs/tsc.txt
