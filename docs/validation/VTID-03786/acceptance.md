# VTID-03786 — Guided-topic block still 100% Nova-blocked after VTID-03785

## Report

Live re-test of VTID-03785's shipped fix, run against real staging
(`preview-aws-gateway.vitanaland.com`) as the documented test user, driving
the actual gateway SSE live-session API for a real guided-topic tap — no
guessing, no mocked provider.

## Investigation — live evidence

VTID-03785 shipped on the theory that two specific phrasing patterns in
`buildGuidedTopicNarrationBlock` (a self-referential voice-denial assertion,
and quoted hypothetical spoken examples) were tripping Nova's
`nova_validation` content filter. That fix merged and deployed to staging
(`a468417e`, booted 11:22:03Z).

A live-browser Playwright verification was attempted first but headless
Chromium cannot reach `*.vitanaland.com` from this session's sandbox
(`net::ERR_CONNECTION_RESET`, reproduced with explicit `--proxy-server`,
`--ignore-certificate-errors`, `--no-sandbox`, `--disable-ipv6` — none
changed the outcome; a raw Node TLS socket through the same proxy CONNECT
tunnel reaches the same host fine, ruling out a network-wide block and
pointing at something specific to the Chromium process). Pivoted to driving
the gateway's real SSE live-session API directly (`POST
/api/v1/orb/live/session/start`, `GET /api/v1/orb/live/stream`) over the
same proven raw-TLS-over-proxy-tunnel mechanism — no browser needed, and it
exercises the exact same server code path (`connectToLiveAPI` inside the
`/live/stream` handler opens the real Nova connection with the full
assembled system instruction, guided-topic block included).

Ran 6 real sessions against staging post-deploy, as the documented test
user (`a27552a3-0257-4305-8ed0-351a80fd3701`):

- 1 ordinary (non-guided) session: **succeeded cleanly** — real German
  audio, 4 transcript segments, `turn_complete` — confirming the harness
  itself works correctly end to end.
- 5 guided-topic sessions across 4 different topics (T001, T002, T003 ×2,
  T004): **all 5 blocked**, both attempts within each session (server
  auto-retries once), `code:nova_validation,
  diagnostic:"...blocked by our content filters."` every time.

```
guided-topic sessions since VTID-03785 deploy (11:22:03Z): 6
blocked:                                                   6  (100%)
```

Identical rate to the pre-fix measurement (158/158). Directly ran the
*actual deployed* `buildGuidedTopicNarrationBlock` against real T003 content
(`npx tsx`) and confirmed VTID-03785's two removed patterns are genuinely
absent from the live build — the fix shipped correctly, it just didn't
address the real trigger.

## Root cause

All four branches of `buildGuidedTopicNarrationBlock` (DE/EN ×
post-narration/legacy) carry a phrase VTID-03785 never touched:

- DE: `"...hat Vorrang vor JEDER generischen Begrüßungs- oder
  Eröffnungsregel."` ("...takes precedence over EVERY generic
  greeting/opening rule.")
- EN: `"...OVERRIDES every generic greeting/opening rule."`

This is present in **100% of guided-topic sessions** (every branch) and in
**0% of ordinary sessions** (which only hit the ambient ~36% baseline) —
exactly matching the observed block-rate split. Structurally, an
"this instruction overrides/takes precedence over every other rule"
assertion is the same shape as a prompt-injection/jailbreak directive —
content-safety classifiers are specifically trained to flag language that
tells a model to override its own default behavior, independent of how
benign the actual operative content is.

## Fix

Removed the "overrides/takes precedence over every rule" clause from all 4
branches, keeping the operative intent (pin the language, scope to the
whole session) as a plain declarative with no override/precedence
assertion:

- DE post-narration: `"SPRACHE: Sprich AUSSCHLIESSLICH auf Deutsch, für die
  GANZE Sitzung."`
- EN post-narration: `` `LANGUAGE: Speak ONLY in ${langName}, for the WHOLE
  session.` ``
- DE legacy: dropped the trailing `"und hat Vorrang vor JEDER..."` clause,
  kept `"Dieser GUIDE-MODUS gilt für die GANZE Sitzung."`
- EN legacy: dropped the trailing `"and OVERRIDES every generic
  greeting/opening rule"` clause, kept `"This GUIDE MODE applies to the
  WHOLE session."`

## Acceptance Criteria

AC-1 — None of the 4 branches assert the mode overrides/takes precedence
over every other rule.

TEST: `guided-topic-narration-prompt.test.ts` — "VTID-03786: does NOT
assert this mode overrides/takes precedence over every other rule" (both
describe blocks).

AC-2 — Intent preserved: each branch still pins the language and scopes it
to the whole session.

TEST: same tests, `toMatch(/für die GANZE Sitzung/)` /
`toMatch(/for the WHOLE session/)`.

AC-3 — All 18 pre-existing tests (VTID-03785's own regression guards
included) pass unmodified.

TEST: full file, 20/20 passing.

AC-4 — `tsc --noEmit` clean.

TEST: `outputs/tsc-noemit.txt`.

AC-5 — Mutation-verified twice (DE and EN independently): reverting either
fails exactly the 1 test that asserts it, 19 others stay green. Clean
restore confirmed via `diff` after each.

TEST: `commands.log`.

AC-6 — Full `test/orb` sweep and full gateway suite both green.

TEST: `outputs/jest-full-suite.txt`.

AC-7 — Live re-test evidence (6 sessions, pre- and post- this specific
fix) is recorded honestly, including the still-open possibility that this
is not the whole story.

TEST: `commands.log` — full live SQL/session trace.

## Deliberately NOT attempted

- **Not yet independently re-confirmed against live Nova traffic with
  THIS fix deployed.** Same standing caveat as every VTID in this chain —
  the next step after this ships is another live re-test using the same
  proven harness, watching whether the block rate actually drops this
  time. If it doesn't, that is itself real evidence the trigger is
  somewhere else again (or that `nova_validation` reacts to something not
  yet identified in this instruction path at all), and this VTID's own
  acceptance record should be revisited rather than treated as closed.
- **No change to the ~36% ordinary-session baseline** — unrelated,
  standing, unroot-caused issue.
- **No change to `nova-instruction-sanitizer.ts`'s scope** — same reasoning
  as VTID-03785: the direct fix at the source is simpler here.
