# Sparring round 3 — converged

Session: `6da8bdd3-19c4-4c25-aacd-30cd0e3d2164` · plan hash `e4952c77985d1c9a456eeefa26074aa7a2d72b2113faa354ef7366691724f71d`

## Summary

Both R2-F1 (caller destructuring + fakeClient wiring) and R2-F2 (test at :140 updated to assert `next_actor: 'kiro'`) are now explicitly addressed in the revised plan and acknowledged below. Two new minor gaps were found: the plan describes the window-expiry extension to `retryInfra` by outcome but never writes the new formula, and the in-scope comment at lines 32–33 of `plan-spar.mjs` is made factually wrong by Change 4 but is not listed for update. Neither is a correctness blocker given the test coverage, but both should be closed before the implementer starts work.

## Findings

### R3-F1 [minor]

The plan describes the window-expiry extension to `retryInfra` (line 188) only by outcome ('is also true for an entry with `retry_exhausted` whose `exhausted_at` is older than the window') but never gives the new formula. The current constant `retryInfra = cur && cur.verdict === 'escalated' && cur.infra && cur.retryable` will evaluate to `false` after exhaustion because `entry.retryable` is set to `false` when `retryExhausted = true`. The implementer must independently derive the window check using `now()` (which is in scope at :168 as a step() parameter) and `PARTNER_INVALID_WINDOW_MS`. The plan does not state where `PARTNER_INVALID_WINDOW_MS` is defined in `plan-spar.mjs` nor what the full replacement formula looks like.

- `exafyltd/vitana-platform:scripts/collab/plan-spar.mjs:168` — export async function step({ dir, slug, baseSha, repo, client, allocate = false, extraRefs = null, now = Date.now }) {
  ...
  let session;
  let action;
  const retryInfra = cur && cur.verdict === 'escalated' && cur.infra && cur.retryable;
- `exafyltd/vitana-platform:scripts/collab/plan-spar.mjs:30` — const INFRA_REASONS = ['model_unavailable', 'code_access_unavailable', 'deadline_exceeded', 'partner_output_invalid'];
const RETRYABLE_REASONS = ['model_unavailable', 'code_access_unavailable', 'deadline_exceeded'];

Suggestion: Add the exact new formula to the plan, e.g.: `const windowExpired = cur?.exhausted_at != null && now() - new Date(cur.exhausted_at).getTime() > PARTNER_INVALID_WINDOW_MS; const retryInfra = cur && cur.verdict === 'escalated' && cur.infra && (cur.retryable || windowExpired);` and explicitly state that `PARTNER_INVALID_WINDOW_MS` is a module-level constant in `plan-spar.mjs`. The test 'with `now` moved past the window, the next push creates once more' would catch an omission, but the formula should not be left entirely to inference.

### R3-F2 [minor]

The comment at `plan-spar.mjs:32–33` says 'the plan goes to Claude, never parked … anything else waits for Claude Code.' Change 4 makes both clauses false: retryable infra → `next_actor: kiro`; non-retryable or exhausted → `next_actor: owner`. The plan lists no update to this comment, so it will ship contradicting the new behaviour immediately below it.

- `exafyltd/vitana-platform:scripts/collab/plan-spar.mjs:32` — // Partner-side failures (not a plan problem): the plan goes to Claude, never parked. Only the gateway's own
// RETRYABLE_REASONS (plan-sparring-service.ts) are re-run automatically; anything else waits for Claude Code.
const INFRA_REASONS = ['model_unavailable', 'code_access_unavailable', 'deadline_exceeded', 'partner_output_invalid'];
const RETRYABLE_REASONS = ['model_unavailable', 'code_access_unavailable', 'deadline_exceeded'];
- `exafyltd/vitana-platform:scripts/collab/plan-spar.mjs:277` — write(handoffPath, appendLog(setFrontMatter(ht, infra
  ? { next_actor: 'claude', updated: t }
  : { state: 'parked', …, next_actor: 'claude', updated: t }),
log(infra ? 'escalated (partner unavailable)' : …,
  infra ? `The sparring partner … Claude Code looks at the partner, then re-runs.`
        : `Not converged after …`)));

Suggestion: Add `plan-spar.mjs:32–33` to the list of lines the plan touches. The replacement should read something like: 'Partner-side failures (not a plan problem): retryable reasons are re-run automatically by Kiro on the next push (capped at 2 per 24 h); other infra reasons or exhaustion hand off to the owner. Never parked.'

## Acknowledgements of earlier responses

- R2-F1: acknowledged — The revised plan now explicitly specifies all three required items: (1) `let deduplicated = false; let retryExhausted = false;` declared next to `let session` at :186; (2) the call site at :194 destructures `{ session, deduplicated, retry_exhausted: retryExhausted }`; (3) `fakeClient.create` at test :39 wraps `take()` as `{ session: take(), deduplicated: false, retry_exhausted: false }`. The rationale is sound.
- R2-F2: acknowledged — The revised plan now explicitly updates the test at :140: renamed, `next_actor` changed to `'kiro'`, log line updated to say 'next push re-runs the partner', and retry/session assertions left unchanged. The new test for non-retryable infra/exhausted setting `next_actor: 'owner'` and the statement 'no test asserts `claude` after this lane' are also present. Rationale is sound.
