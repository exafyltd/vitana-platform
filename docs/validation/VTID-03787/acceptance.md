# VTID-03787 — Diagnostic-only Nova instruction dump (staging-gated)

## Report

VTID-03785 and VTID-03786 both removed specific "risky phrasing" patterns
from the guided-topic system-instruction path, on the evidence-backed
theory that Nova's `nova_validation` content filter reacted to them. Both
shipped correctly (mutation-verified independently, each) and both were
deployed to staging and live-retested via a real SSE harness against real
Nova traffic. **Both left the block rate unchanged at 100%** — 6/6 guided
sessions across 6 different topics, identical `nova_validation` /
"blocked by our content filters" error, both retry attempts, every time —
falsifying the "risky phrase" theory as the (sole) cause.

Per explicit platform-owner direction, continuing to dig rather than
shipping a fourth guess.

## What this VTID does — and does not do

This ships **diagnostic instrumentation only, no fix**. It dumps the
ACTUAL literal `novaSystemInstruction` text — the exact string handed to
`novaClient.connect({ systemInstruction: ... })` — to a new `oasis_events`
diag stage (`nova_instruction_debug_dump`) immediately after it is
computed, so a real blocked guided-topic session's full instruction can be
diffed character-for-character against a real succeeding ordinary
session's, instead of guessing another phrase pattern blind.

Gated behind `ORB_LOG_NOVA_INSTRUCTION_DEBUG` (exact-`"true"` opt-in,
**staging only** — deliberately never wired into
`AWS-PROD-DEPLOY-GATEWAY.yml`), because the dumped text includes the real
user's memory/personalization context assembled into the instruction.

## Fix / Change

`services/gateway/src/routes/orb-live.ts` — right after
`novaSystemInstruction` is computed (same point `_novaInstructionChars`/
`_novaToolEntryCount` are already stashed for the `connect_failed` OASIS
payload), added a gated `emitDiag(session, 'nova_instruction_debug_dump',
{...})` call carrying the full instruction text, its length, and whether
the session is a guided-topic session.

`.github/workflows/AWS-STAGE-DEPLOY-GATEWAY.yml` — added
`ORB_LOG_NOVA_INSTRUCTION_DEBUG` to both the strip list (so a stale value
can't survive a future edit) and the re-add list with `value:"true"`,
matching the established pattern (`ORB_FULL_DUPLEX_ENABLED`,
`ORB_DAY_CLOSE_RUNG_ENABLED`). `AWS-PROD-DEPLOY-GATEWAY.yml` is
deliberately untouched.

## Acceptance Criteria

AC-1 — Staging pins `ORB_LOG_NOVA_INSTRUCTION_DEBUG` as exact `"true"`,
with the strip-first/re-add pattern so a stale value can't survive.

TEST: `staging-nova-instruction-debug-flag-pinned.test.ts` — "upserts the
flag as exact-\"true\" on staging", "strips the inherited value first".

AC-2 — Prod never sets this flag (the dumped text carries real user
context).

TEST: same file — "is NEVER set on the prod deploy workflow".

AC-3 — `orb-live.ts` gates the dump behind the exact string check and
emits the literal instruction text on the documented diag stage.

TEST: same file — the two `orb-live.ts gates...` tests.

AC-4 — `tsc --noEmit` clean.

TEST: `outputs/tsc-noemit.txt`.

AC-5 — Full `test/orb` sweep and full gateway suite both green.

TEST: `outputs/jest-full-suite.txt`.

## Deliberately NOT attempted

- **No fix.** This is diagnostic-only, matching this codebase's own
  established precedent (VTID-03764: "diagnostic instrumentation only, no
  fix yet" before its own latency investigation) for exactly this
  situation — real measured data before another guess.
- **Not gated behind mutation testing** the way a behavior-changing fix
  would be — there is no behavior to mutate-test here beyond the pinning
  tests already covering the flag wiring.
- **The actual diff has not happened yet.** The next step, immediately
  after this deploys to staging, is running one real blocked guided-topic
  session and one real succeeding ordinary session through the same proven
  SSE harness, pulling both `nova_instruction_debug_dump` events from
  `oasis_events`, and diffing the literal text.
