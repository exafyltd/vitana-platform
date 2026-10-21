# VTID-04369 — Conversation rebuild WS-0.6: split `nova_validation`, fill the opener Monitor columns

Plan v1 (Conversation Intelligence Rebuild), Phase 0, workstream WS-0.6.
Ships in PR #3614 as a companion to VTID-04339.

## What was wrong (measured, read-only, on production `oasis_events`, last 30 days)

- **One error code covers three unrelated failures.** Every `nova_validation`
  close is recorded under the same code (`stage='upstream_error'`,
  `code='nova_validation'`):

  | diagnostic | count |
  |---|---|
  | "Timed out waiting for audio bytes or interactive content … less than 55 / 295 seconds" (idle stream) | 94 |
  | "All contents must be closed before ending prompt" (a protocol-ordering error on our side) | 38 |
  | "This request has been blocked by our content filters." (the real guardrail block) | 37 |

  Any content-filter rate computed on the code alone was about 4.6× too high.
  VTID-04124 had to join on `diagnostic ILIKE` to get the real 10.1%.
- **Most openers leave the Monitor columns blank.** Command Hub → Conversation →
  Monitor reads `register`, `bucket`, `nba`, `nba_domain` and `current_route`
  from each `greeting_sent` diag, and only the `conv_resume` rung filled them.

## Fix

- **`classifyNovaFailureKind(code, diagnostic)`** (`nova-sonic-live-client.ts`)
  returns `content_filter | idle_timeout | prompt_protocol | other` for
  `nova_validation`, and null for every other code.
  - The Nova client stamps `failure_kind` on every error it emits.
  - The `upstream_error` diag carries it.
- **`withGreetingMonitorFields(diag, ctx)`**
  (`services/conversation/greeting-monitor-fields.ts`) fills the Monitor
  columns on both `greeting_sent` emit sites. Precedence, per column:
  1. the rung's own value;
  2. what the session knew at emit time (temporal bucket, `current_route`, language);
  3. a register derived from the opener;
  4. `null`.

  A rung-provided value is never overwritten. The next-best action stays
  `null` unless the rung computed one, so nothing is invented.

## Found, not fixed here

- **`prompt_protocol` (38 in 30 days) is our own defect**, not a Nova filter:
  a prompt was ended while a content block was still open. It now has its own
  count, and fixing it is its own VTID.
- **The retry keys are unchanged.** `shouldRetryDayCloseReduced()` and the
  guided-topic fallback still key on `code === 'nova_validation'`. Narrowing
  them to `failure_kind === 'content_filter'` changes live retry behaviour,
  so it is left for a follow-up with its own before/after measurement.

## Acceptance criteria

AC-1: Each real production diagnostic maps to its kind; every non-`nova_validation` code gets no kind.
TEST: services/gateway/test/orb/live/vtid-04369-failure-kind-and-monitor-fields.test.ts

AC-2: The Nova client sets `failure_kind` on its errors, and the `upstream_error` diag carries it.
TEST: services/gateway/test/orb/live/vtid-04369-failure-kind-and-monitor-fields.test.ts

AC-3: Every `greeting_sent` diag carries register, bucket, nba, nba_domain, current_route and lang; rung values win; nothing is invented.
TEST: services/gateway/test/orb/live/vtid-04369-failure-kind-and-monitor-fields.test.ts

AC-4: The safe-fast ladder still delegates to the brain and emits the brain's diag.
TEST: services/gateway/test/orb/live/characterization/vertex-safe-fast-ladder.characterization.test.ts

AC-5 (post-deploy, staging): new `upstream_error` rows with `code='nova_validation'` carry a non-null `failure_kind`, and new `greeting_sent` rows for non-`conv_resume` openers have a non-null `register`.
CURL: read-only SQL on oasis_events after the next staging voice sessions (no writes).
