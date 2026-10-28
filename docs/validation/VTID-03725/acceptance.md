# VTID-03725 — Serbian ORB voice: routing diagnosis (Turkish fixed elsewhere)

VALIDATION_PROFILE: gateway_backend

Platform owner report: "Turkish speaks English and Serbian doesn't say
nothing at all. Serbian should be wired to Nova."

**Turkish is already fixed, by a different, concurrently-developed PR.**
This session root-caused the Turkish gap independently (`tr` missing from
`SUPPORTED_LIVE_LANGUAGES` and six sibling tables — the VTID-03578/03681
pt/pl shape) and opened PR #3183 to fix it. Before that PR could merge,
`main` advanced past it with VTID-03730 (#3187, merged as `86b71bb`) — a
different Claude Code session's independent, functionally-equivalent fix
covering the same file set (different specific voice-id choices: `Puck`
vs. this session's `Sulafat`, etc.). PR #3183 was abandoned rather than
conflict-resolved against an already-shipped duplicate; AC-1 below confirms
the shipped fix is real and complete, not merely claimed.

**Serbian was NOT a routing bug.** `sr` already correctly forces onto Nova
Sonic via existing, correct code — confirmed by reading
`upstream-provider-selector.ts`/`cascaded-config.ts` and cross-checked
against live `oasis_events`. The real defect, found by direct live-telemetry
investigation rather than assumed, is that Nova frequently produces zero
real turns for Serbian sessions with no error signal at all — a distinct
failure mode from the already-documented "premature close" bug (§2e of
CLAUDE.md), consistent with Serbian being absent from AWS's own official
Nova 2 Sonic supported-language table (en/fr/it/de/es/pt/hi). This PR is a
diagnosis-only evidence pack: no code changes, because building a
speculative fix (e.g. a new idle-timeout retry) against a bug this session
cannot reproduce on demand would trade a documented, honest gap for
unverified new session-lifecycle logic — the concrete next step is named in
AC-4, not built here.

---

AC-1 — Turkish is genuinely fixed on `main` (VTID-03730/#3187), not merely
believed fixed — re-verify the shipped tests actually pass today, since this
session did not write them

TEST: `services/gateway/test/orb/live/language-coverage.test.ts` —
"VTID-03730: Turkish end-to-end, same seam the pt/pl expansion closed" (all
6 cases), re-run against current `main` HEAD (unmodified by this PR)
TEST: `services/gateway/test/orb/live/upstream/cascaded-voice.test.ts` —
"takes exactly the languages Nova cannot speak AND both AWS services can"
(asserts `tr` → `tr-TR`, `listCascadeLanguages()` includes `tr`)
Output: outputs/targeted-tests.txt (24/24 passing, both suites green)

AC-2 — Serbian's routing is already correct: `sr` cannot be cascade-rescued
(Polly has no Serbian voice in any engine) and therefore always forces onto
Nova Sonic via `nova_forced_vertex_unavailable` — this is NOT the reported
defect, and no routing code change is warranted

TEST: `services/gateway/test/orb/live/upstream/cascaded-voice.test.ts` —
"refuses sr, and blames POLLY — the blocker that is actually verified"
(pre-existing, unmodified by this PR, re-run to confirm it still holds)
TEST: same file — "with the flag on but the language NOT covered (sr), it
does not divert" — confirms the selector keeps `sr` on
`nova_forced_vertex_unavailable` even with the cascade flag on
Output: outputs/targeted-tests.txt

AC-3 — Live evidence that Serbian's real defect is Nova silently producing
zero turns, not a routing/connection error — a distinct shape from the
documented "premature close" (audio_out=0, code=nova_stream_error) failure

CURL: `commands.log` (Supabase PostgREST query against `oasis_events`,
joining `vtid.live.session.start` filtered on `lang='sr'` to the paired
`vtid.live.session.stop` by `session_id` — `session.stop` carries no `lang`
field itself, hence the join) — 20 real Serbian sessions sampled, roughly
half showing `turn_count:0`/no real audio_out with no `code`/`diagnostic`
populated at all, distinct from the `nova_stream_error`/"Premature close"
rows also present in the same sample
Output: outputs/serbian-telemetry-notes.md (query + interpretation; raw rows
are user session data and are not persisted verbatim in this evidence pack)

AC-4 — the concrete next step is named, not silently left as a vague
TODO: extending `resendGreetingIfStuckAtZeroTurns`-style recovery to an
idle-timeout trigger, since today all 3 call sites only fire from inside
upstream-WS close-event handlers and never from "connection open, zero
turns, no close event at all"

TEST: `grep -n resendGreetingIfStuckAtZeroTurns
services/gateway/src/routes/orb-live.ts` plus the surrounding branch context
confirms all 3 call sites (VTID-03647-guided-topic-fallback,
VTID-03557-retry, VTID-03502-fallback) sit inside `closeEvent`-driven
reconnect branches — none is reachable from an open-but-silent connection
Output: outputs/resend-callsites.txt

AC-5 — no regression: this PR is documentation-only

TEST: `git diff --stat origin/main...HEAD` — only files under
`docs/validation/VTID-03725/` changed; no `services/gateway/src/**` or
`services/gateway/test/**` file is touched
Output: outputs/diff-stat.txt

---

## Deliberate judgment calls, recorded rather than silently made

1. **No Turkish code change is included here**, even though this session
   independently diagnosed and drafted a fix (abandoned branch
   `fix/turkish-serbian-nova-voice-vtid-03720`, PR #3183, closed as
   superseded). Re-implementing or rebasing onto VTID-03730's already-merged
   equivalent would either duplicate work already on `main` or produce a
   second, conflicting implementation with different voice-id choices for
   no behavioral gain. AC-1 exists specifically to verify the shipped fix
   independently rather than trust the other session's PR description.

2. **No speculative Serbian fix is included.** The honest diagnosis is that
   Nova — not Vitana's routing — silently fails to produce turns for
   Serbian roughly half the time, and Serbian is not in AWS's own published
   Nova 2 Sonic language table. A fix here would mean new,
   untested session-lifecycle retry logic (an idle-timeout trigger that
   does not exist anywhere in this codebase today) built against a failure
   this session cannot reproduce on demand. That is exactly the
   "manufacture a code change without a new, real defect to point at"
   pattern CLAUDE.md's own change log (VTID-03646 row) explicitly warns
   against repeating.

3. **Raw `oasis_events` rows are not committed verbatim** to
   `outputs/serbian-telemetry-notes.md` — they contain `session_id`s and
   could be correlated back to real user sessions. The notes file records
   the query, the aggregate counts, and the interpretation, which is what
   the diagnosis rests on.

OASIS_IMPACT: no
