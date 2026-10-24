# Sparring round 1 — in_progress

Session: `2435e2ed-a917-402c-b2a4-577f057ac9fd` · plan hash `38467ced42afc3e928f4781f25a93bc4167379bc2fa9ce7682bd13461ed9d4af`

## Summary

Verified 8 distinct premises against the pinned commit using read_file. Six hold cleanly; the exchangeRates.ts line count is wrong (127 not 117). Two material findings: (1) /redeem is an explicitly unauthenticated public route on mobile web and the plan never specifies which auth boundary the native port belongs to — a silent parity break if placed inside the authenticated (app) layout group; (2) packages/core/extract.json exists alongside manifest.json but is never mentioned in the wallet-home core-extraction procedure, leaving open whether --write touches it. Two minor findings: the line-count measurement error and the new Date() non-determinism in exchangeRates tests.

## Findings

### R1-F1 [major]

`/redeem` is an explicitly public, unauthenticated route in App.tsx. The plan never decides which auth boundary the native RedeemVoucher screen belongs to, risking a silent parity break if it is placed inside the authenticated `(app)` layout group.

- `exafyltd/vitana-v1:src/App.tsx:843` — /* Public Routes - No Auth Required */
<Route path="/reset-password" element={<ResetPassword />} />
...
<Route path="/redeem" element={<RedeemVoucher />} />
- `exafyltd/vitana-v1:src/App.tsx:1558` — <Route path="/wallet" element={
  <AuthGuard>
    <Wallet />
  </AuthGuard>
} />

Suggestion: Every other wallet-lane route is wrapped in AuthGuard; `/redeem` is the sole wallet-lane destination that is deliberately public on mobile web today. The plan's parity guarantee ('no gate added, removed, widened or narrowed') applies only to IAP gates, leaving the auth-boundary question completely silent. The `wallet-rewards` lane spec must explicitly decide: (a) place the native RedeemVoucher screen outside the authenticated `(app)` layout group to preserve unauthenticated access, or (b) place it inside `(app)` and register an exception row in the parity ledger documenting the intentional narrowing. Without this decision the native port will silently require auth where mobile web does not.

### R1-F2 [major]

`packages/core/extract.json` exists in the same directory as `manifest.json` and `closure.generated.json` but is never mentioned in the plan's core-extraction procedure for the `wallet-home` PR. If `core-closure.mjs --write` reads or mutates it, the `--check` gate will still fail after the PR lands.

- `exafyltd/vitana-v1:packages/core/manifest.json:1` — {
  "_doc": "VTID-05183 — every web module @vitana/core re-exports, with its reason and consumer lanes. A lane that needs another transitively class-A module adds a line here and a re-export in its own PR; scripts/native/core-closure.mjs --check is the gate (it fails on a re-export missing here, a line nothing re-exports, or a module that is not class A).",

Suggestion: Read `packages/core/extract.json` and `scripts/native/core-closure.mjs` before the wallet-home PR is written. If `--write` mutates `extract.json`, add it to the commit checklist in the lane spec alongside `closure.generated.json` and `mobile-ci-paths.generated.json`. If `--write` does not touch it, add a one-line comment in the lane spec explicitly confirming this so reviewers do not flag it as a missing step.

### R1-F3 [minor]

The plan's measured-state asserts `src/lib/exchangeRates.ts` is 117 lines; the file at the pinned commit is 127 lines.

- `exafyltd/vitana-v1:src/lib/exchangeRates.ts:115` — export const convertToUsd = (
  amount: number,
  from: DisplayCurrency,
  eurPerUsd: number = EUR_PER_USD,
): number => (from === 'EUR' ? amount / eurPerUsd : amount);

Suggestion: Correct the measured-state line count to 127. The class-A classification is unaffected — the file has zero import statements and no file/network I/O — but the error erodes confidence in other unverified measurements in the plan.

### R1-F4 [minor]

`getCurrentExchangeRates()` calls `new Date()` on every invocation, making the `lastUpdated` field non-deterministic. The test plan specifies 'exchangeRates pure-module tests' without addressing this, so snapshot or equality tests will be flaky or incorrect.

- `exafyltd/vitana-v1:src/lib/exchangeRates.ts:27` — export const getCurrentExchangeRates = (): ExchangeRate[] => [
  {
    from: 'USD',
    to: 'CREDITS',
    rate: 100,
    trend: 'stable',
    change24h: 0,
    lastUpdated: new Date()
  },
  ...

Suggestion: Either (a) pure-module tests must use `jest.useFakeTimers()` or assert `lastUpdated` with `expect.any(Date)` rather than deep-equality, or (b) the core re-export freezes `lastUpdated` to a compile-time constant. Document the chosen approach in the lane spec so the test author does not write a test that is stale on the next millisecond.

## Next

Planner: answer every finding above in `sparring/responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
