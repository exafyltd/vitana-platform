# VTID-03985 — Cascade voice: retry when the LLM returns ok-but-empty text

## Report

Reported live by the platform owner: a real staging voice session on
`preview-aws.vitanaland.com` opened, spoke its greeting, then went silent
and eventually failed with a generic "Live API connection error" — this
was the mobile-app-facing MAXINA voice widget, not the Command Hub.

Traced via a direct, read-only `oasis_events` query against the exact
session (`live-50fa2f62-62f6-4198-a677-20d654e7fe11`). The session is a
**cascaded** voice session (`nova_language_supported:false` — Nova Sonic
does not speak Serbian natively, so it correctly fell to the
Transcribe→Bedrock/DeepSeek→Polly/Fish cascade, which VTID-03984's Fish
Audio wiring made eligible for `sr` for the first time). The greeting
audio played once (`audio_out:1`), then 4.5s later:
`code:"cascade_llm_empty", stage:"upstream_error"` — the cascade's LLM
call (`callViaRouter('operator', ...)`, currently routed primary to
`deepseek/deepseek-flash` per VTID-03817) returned `ok:true` with **empty
text**. `callViaRouter` only escalates to the stage's fallback model on an
explicit failure (`ok:false`); an "ok but empty" response is treated as a
success with nothing to say. With no retry and no spoken fallback, the
turn silently dropped and the session sat in dead air for the full 30s
stall-watchdog window (`reason:"greeting_timeout"`) before closing —
which is what surfaced to the user as a generic, unhelpful error.

Confirmed via a direct query this is the FIRST-EVER `cascade_llm_empty`
event (zero prior occurrences in 7 days of `oasis_events`) — a genuine
first-exercise bug the Fish Audio activation exposed, not something Fish
Audio itself caused (the failure is upstream of TTS entirely — `synthesizePolly`/
`synthesizeFish` are never reached when `replyText` is empty).

## Fix

`CascadedLiveClient.runTurn()` (`cascaded-live-client.ts`): when the
primary completion is `ok:true` with empty (trimmed) text, and the router
did not already use its own fallback (`!completion.fallbackUsed`), retry
once with an explicit `providerOverride:'bedrock'`,
`modelOverride:'eu.anthropic.claude-sonnet-4-6'` (confirmed live-invokable,
CLAUDE.md §2b — this is also the stage's own currently-configured
`fallback_provider`/`fallback_model`, read live from `llm_routing_policy`
before writing this fix), `allowFallback:false` (no point cascading back
to itself). Only reports `cascade_llm_empty` if BOTH the primary and the
retry come back empty. An explicit primary failure (`ok:false`) is
unchanged — `cascade_llm_failed` still fires immediately, no retry (a
credential/access error retrying against the same-shaped call rarely
helps and the existing behaviour there was never the bug).

## Acceptance Criteria

AC-1 — an `ok:true` primary completion with empty text retries against the
confirmed-invokable Bedrock fallback model before giving up, and a
non-empty retry result completes the turn normally (transcript emitted,
TTS synthesized, audio chunks emitted, `turnComplete` fires).

TEST: `test/orb/live/upstream/cascaded-live-client-empty-completion.test.ts`
— "retries against the fallback model and completes the turn when the
retry has real text".

AC-2 — if BOTH the primary and the retry return empty text,
`cascade_llm_empty` still fires (now after two attempts, not one), and no
TTS call is ever made for empty content.

TEST: same file — "reports cascade_llm_empty only after BOTH the primary
and the retry come back empty".

AC-3 — when `callViaRouter` already used its own internal fallback
(`fallbackUsed:true`) and STILL returned empty text, no second retry is
attempted (retrying the same already-exhausted fallback model would be a
no-op) — `cascade_llm_empty` fires immediately.

TEST: same file — "does NOT retry when the primary already used the
router-level fallback".

AC-4 — an explicit primary failure (`ok:false`) is unchanged: no retry,
`cascade_llm_failed` fires immediately (this was never the bug and must
not regress).

TEST: same file — "does not retry on an explicit primary failure".

AC-5 — a normal, non-empty primary reply never triggers the retry path at
all (zero behaviour change for the overwhelmingly common case).

TEST: same file — "a non-empty primary reply never triggers a retry call
at all".

## Verification

TEST: `outputs/tsc-noemit.txt` — `tsc --noEmit`, clean (exit 0).

TEST: `outputs/jest-cascaded-suites.txt` — all four `cascaded*` test
suites (including the 3 pre-existing ones, unmodified) re-run together:
34/34 passing, 0 regressions.

TEST: `outputs/npm-build.txt` — `npm run build`, clean (exit 0).

TEST: `outputs/jest-full-suite-tail.txt` — full gateway suite re-run:
932/933 suites (1 pre-existing skip, matches CLAUDE.md's own documented
baseline), 15,276/15,311 tests passing, 0 failures.

## Not yet independently confirmed

This fix has not yet been observed against a fresh live session — the
next real signal is either the reporting user's next `sr` (or any
cascade-eligible language) voice session completing a real turn instead
of dead air, or, if it still fails, a NEW error code in `oasis_events`
(meaning both attempts genuinely failed, which is now at least fast and
visible instead of a silent 30s hang).

OASIS_PROOF: `oasis_events`, topic `orb.live.diag`, `metadata->>'code' =
'cascade_llm_empty'` — pre-fix baseline is exactly 1 event
(`live-50fa2f62-62f6-4198-a677-20d654e7fe11`, 2026-09-16T22:23:44.615Z).
Confirm no NEW occurrence after this deploys where a retry with real text
should instead have produced a completed turn.
