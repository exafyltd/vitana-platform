---
change_class: light
---
# plan(outbox-test-dates): the VTID-05320 send-status test stops failing 7 days after it was written
<!-- plan:begin -->
## Problem
Since 2026-10-28 `Vitest (jsdom)` is red on vitana-v1 `main` (`5bc8d10cd`, a docs-only commit) and on every open
PR, which blocks all merges. Two tests fail in `src/hooks/useGlobalMessages.send-status.vtid-05320.test.tsx`:
"re-posts a pending item once…" and "several mounted instances share one outbox…"
(`AssertionError: expected [] to deeply equal [ 'was in flight:server', … ]`). The previous commit `a6c5bd073` was
green in CI, but run locally today it fails the same way. So the cause is the clock, not a code change.

## Premises (read-only, `exafyltd/vitana-v1` @ `5bc8d10cd2ceaf994320bc8d7d3f88c2db7edc31`, pinned in `handoff.md` `spar_refs`)
1. `exafyltd/vitana-v1:src/lib/messaging/outbox.ts:46-48` defines `OUTBOX_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000`. `:89-91`
   `prune()` drops items whose `created_at` is older than that.
2. `exafyltd/vitana-v1:src/hooks/useGlobalMessages.send-status.vtid-05320.test.tsx:204-205,261` seeds the outbox with fixed
   `created_at: '2026-10-21T10:00:00.000Z'` / `'…10:00:01…'`. From 2026-10-28T10:00Z these items are pruned
   before the reload re-post, so the assertions see `[]`.
3. The other fixed dates in the file (`:79`, `:231-250`) are message rows, not outbox items, and are not pruned.

## Change — one lane `relative-dates` (vitana-v1, test file only)
- In the test file, add `OUTBOX_T0 = new Date(Date.now() - 10 min).toISOString()` and `OUTBOX_T1 = OUTBOX_T0 + 1 s`,
  with a comment naming `OUTBOX_MAX_AGE_MS`. The three outbox fixtures use them. 10 min is past
  `SENT_GRACE_MS` (2 min, `outbox.ts:46`) and well inside 7 days, the same relation as the original fixtures when they
  were written. No assertion is loosened, no test is skipped, and no source file changes.

## Test plan
- Red: the file fails 2/17 on `origin/main` today. Green: 17/17 on the lane head. Full `npx vitest run` green.
- Staging: `docs/validation/<VTID>/staging-tests.json` (`kind: existing`, this test file). STAGING-VERIFY runs it.

## Lanes
- `relative-dates` (vitana-v1, seat `exafyltd`, area `messenger`, executor `kiro`, `depends_on: []`). Paths:
  `src/hooks/useGlobalMessages.send-status.vtid-05320.test.tsx`, `docs/validation/VTID-*/**`.

## Out of scope
- Making `serverRow` (`:100`) and the other message-row dates relative. They are not pruned today; a later lane does all of them together (sparring R1-F1, deferred).
- The `public.ecr.aws` "Data limit exceeded" on pr-gate's postgres service image (plan `ci-ecr-public-auth`, premise 4).
<!-- plan:end -->
