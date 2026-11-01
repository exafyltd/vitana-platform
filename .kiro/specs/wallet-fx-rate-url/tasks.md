# Tasks — wallet-fx-rate-url
<!-- lane: fx-url -->
Repo `exafyltd/vitana-v1`. Code starts only after the VTID is allocated (plan § Lanes).
- [ ] T1 Test first: write `src/hooks/useEurUsdRate.test.ts` (plan § Change 2). On `origin/main` run
      `npx vitest run src/hooks/useEurUsdRate.test.ts` and save the output to `docs/validation/<VTID>/red-on-base.txt`:
      the URL test must fail on the URL assertion (old `api.frankfurter.app` URL), not a setup error.
- [ ] T2 `src/hooks/useEurUsdRate.ts`: default URL → `https://api.frankfurter.dev/v1/latest?base=USD&symbols=EUR`,
      comment updated (plan § Change 1). No other line changes.
- [ ] T3 Green on head: the test passes; `npx eslint src/hooks/useEurUsdRate.ts src/hooks/useEurUsdRate.test.ts`
      exits 0. Commands and summaries in `docs/validation/<VTID>/commands.log`.
- [ ] T4 Staging suite: `tests/e2e/staging/vtid-<VTID>-wallet-fx-rate.staging.spec.ts` and
      `docs/validation/<VTID>/staging-tests.json` (UTF-8, no BOM, plan § Change 3).
- [ ] T5 PR titled `VTID-xxxxx (wallet-fx-rate-url/fx-url): …`; every required check green on its head.
Acceptance:
- Change types: Integration (third-party FX endpoint URL), Tooling/docs (Vitest, staging spec, validation records).
- **Outcome** — `/wallet` loads the live EUR/USD rate from `api.frankfurter.dev` with no CORS error; the displayed
  rate falls back to `EUR_PER_USD` exactly as before when the request fails.
- **States / Surfaces / Locales / Accessibility** — no UI change; loading and error states unchanged (static rate).
- **Contract** — request meaning (EUR per 1 USD), `rates.EUR` parsing, errors, query key and cache times unchanged;
  `VITE_FX_RATES_URL` override still wins.
- **Staging proof** — the new read-only suite asserts a `200` from `api.frankfurter.dev` and no `frankfurter`/CORS
  console error on `/wallet` at 1440 and 390.
- No wallet route added or changed (NEVER 26); red on base for the reason fixed, green on head; diff only inside the
  lane `paths`; no test skipped or loosened; files UTF-8 without BOM.
