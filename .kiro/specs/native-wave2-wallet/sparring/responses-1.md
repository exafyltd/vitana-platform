# Planner responses — session 1, round 1

Session: `2435e2ed-a917-402c-b2a4-577f057ac9fd` · answering `round-1.md`.

All four findings accepted and fixed in `plan.md`, each verified against vitana-v1 `main`.

## What changed in `plan.md`

- **R1-F1 (redeem auth boundary, major).** Confirmed `/redeem` sits under "Public Routes - No Auth Required" in
  `src/App.tsx:849` with no `AuthGuard`, while every other wallet route is `AuthGuard`-wrapped. Added decision 2a:
  the native `RedeemVoucher` twin is placed in the **public/unauthenticated** Expo Router group (outside `app/(app)/`),
  preserving web parity; no ledger exception needed because the boundary is preserved, not narrowed; the lane file
  records the placement and a routing test asserts the redeem screen renders without an authenticated session.
- **R1-F2 (extract.json, major).** Read `core-closure.mjs`: `--write` writes only `closure.generated.json` and
  `mobile-ci-paths.generated.json` (`core-closure.mjs:240` writes `r.outputs`; header comment confirms).
  `packages/core/extract.json` is an input, never mutated by `--write`. Documented this in the test plan so the
  `wallet-home` commit checklist excludes it and reviewers do not flag its absence.
- **R1-F3 (line count, minor).** Corrected `exchangeRates.ts` from 117 to **127** lines (measured state + test plan);
  also softened the line-count caveat to "approximate, not load-bearing". Class-A classification unchanged (zero
  imports, no IO).
- **R1-F4 (new Date non-determinism, minor).** `getCurrentExchangeRates()` sets `lastUpdated: new Date()` (two call
  sites). Specified the deterministic test approach in the test plan: assert the fixed fields exactly and
  `lastUpdated` with `expect.any(Date)`, never deep-equality/snapshot.

## Dispositions

```json
[
  {
    "finding_id": "R1-F1",
    "disposition": "accepted",
    "rationale": "Verified on vitana-v1 main: /redeem is declared under the 'Public Routes - No Auth Required' block in src/App.tsx:849 with NO AuthGuard, whereas /wallet, /wallet/balance, /wallet/rewards and /wallet/subscriptions are each wrapped in AuthGuard. The plan was silent on the native auth boundary, risking a silent narrowing if RedeemVoucher landed inside the authenticated (app) group. Chose option (a) to preserve parity: new decision 2a places the native RedeemVoucher twin in the public/unauthenticated Expo Router group (outside app/(app)/) so an unauthenticated member reaches it exactly as on web. No parity-ledger exception row is needed because the boundary is preserved, not changed. The wallet-rewards lane file records the placement and a routing test asserts the redeem screen renders without an authenticated session.",
    "deferred_to": ""
  },
  {
    "finding_id": "R1-F2",
    "disposition": "accepted",
    "rationale": "Read scripts/native/core-closure.mjs on vitana-v1 main: the --write branch writes r.outputs (core-closure.mjs:240), which per the file's header comment and the EXTRACT/CLOSURE_OUT/CI_PATHS_OUT constants are closure.generated.json and mobile-ci-paths.generated.json only. packages/core/extract.json (the EXTRACT constant) is read as input, never written by --write. Documented this explicitly in the test plan so the wallet-home commit checklist is exactly {closure.generated.json, mobile-ci-paths.generated.json} and reviewers do not flag extract.json as a missing commit step; --check therefore cannot fail on a stale extract.json produced by --write.",
    "deferred_to": ""
  },
  {
    "finding_id": "R1-F3",
    "disposition": "accepted",
    "rationale": "Confirmed src/lib/exchangeRates.ts is 127 lines on vitana-v1 main (not 117). Corrected the measured-state line and the test-plan premise to 127, and marked the web-source line counts as approximate/not load-bearing to prevent similar erosion of confidence. The class-A determination is unaffected: the file has zero import statements and no file/network IO.",
    "deferred_to": ""
  },
  {
    "finding_id": "R1-F4",
    "disposition": "accepted",
    "rationale": "Confirmed getCurrentExchangeRates() sets lastUpdated: new Date() (two occurrences in exchangeRates.ts), making that field non-deterministic. Specified the deterministic test approach in the test plan: the exchangeRates pure-module tests assert the fixed fields (from/to/rate/trend/change24h) exactly and assert lastUpdated with expect.any(Date), not deep-equality or snapshot, so they do not go stale on the next millisecond. Chose the test-side option (a) over freezing lastUpdated in the core re-export so the native copy stays a byte-faithful re-export of the pure web module.",
    "deferred_to": ""
  }
]
```

## Next

Committing `plan.md` + this file and pushing to start round 2.
