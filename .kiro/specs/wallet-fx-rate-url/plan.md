---
change_class: standard
---
# plan(wallet-fx-rate-url): the wallet's live EUR/USD rate loads from api.frankfurter.dev, not the CORS-blocked api.frankfurter.app redirect
Author: Kiro, seat `exafyltd`, session `kiro-exafyltd-202611011353-f644` (Kiro IDE, workflow `wf_0c8b8d8455073ad2`,
owner backlog-cleanup task 2026-10-28). Code repo: `exafyltd/vitana-v1`; the spec lives in vitana-platform because
PLAN-SPAR only runs here (pattern of `.kiro/specs/ci-dockerhub-mirror`). Premises pinned to vitana-v1 `origin/main`
`58c76c956` and vitana-platform `origin/main` `62990ce285`. Detail: `tasks.md`; lane file under `lanes/`.
<!-- plan:begin -->
## Goal
Owner task (backlog cleanup, 2026-10-28): "move ahead you can review and you can decide". STAGING-VERIFY run
41300076673 (vitana-v1 `c5c2cab4`) failed suite VTID-05288 on `/wallet` at 1440 and 390 with
`Access to fetch at 'https://api.frankfurter.app/latest?from=USD&to=EUR' … blocked by CORS policy` and
`net::ERR_FAILED`. The same request fails for every member in production, so the wallet's EUR display always shows the
static fallback rate. Make the live rate load again, with the same meaning of the request (EUR per 1 USD), the same
parsing and the same fallback.
## Today (evidence, read-only)
1. `src/hooks/useEurUsdRate.ts:7-9`: `FX_RATES_URL = import.meta.env.VITE_FX_RATES_URL ??
   'https://api.frankfurter.app/latest?from=USD&to=EUR'`. `fetchEurPerUsd` (`:10-19`) throws on `!res.ok` or when
   `data.rates.EUR` is not a finite positive number. `useEurUsdRate` (`:29-43`) returns `query.data ?? EUR_PER_USD`
   (`src/lib/exchangeRates.ts`), so loading and failure both show the static rate; `retry: 1`, `staleTime` 1 h.
2. `api.frankfurter.app/latest?from=USD&to=EUR` now answers `301` to `api.frankfurter.dev/v1/…` without an
   `Access-Control-Allow-Origin` header, so the browser blocks the redirect (curl, 2026-11-01). The new endpoint
   `https://api.frankfurter.dev/v1/latest?base=USD&symbols=EUR` answers `200` with `access-control-allow-origin: *`
   and the body still carries `rates.EUR` (same shape: `{amount, base, date, rates: {EUR: <number>}}`). `base` and
   `symbols` are the documented names of the v1 API for what `from` and `to` meant on the old host.
3. No env override is set anywhere: `git grep VITE_FX_RATES_URL` on `origin/main` finds only the hook (no `.env`,
   no workflow). Callers: `src/pages/Wallet.tsx:167`, `src/components/wallet/RewardShop.tsx:45`,
   `src/components/wallet/popups/AddFundsPopup.tsx:32`. Their tests mock the hook
   (`RewardShop.test.tsx:21`, `src/pages/wallet/mobile-wallet-rewards.test.tsx:93`), so no test covers the URL.
4. No test for the hook exists (`src/hooks/useEurUsdRate.test.ts` is absent). `vitest.config.ts` runs
   `src/**/*.test.{ts,tsx}` in jsdom with `src/test/setup.ts`.
5. The staging suite that saw the error is `tests/e2e/staging/vtid-05288-colours-batch-4.staging.spec.ts` (lane
   `desktop-spotlight-finish/colours-batch-4`, its own `paths`). This plan does not edit it; it adds its own suite.
## Change (lane `fx-url`, vitana-v1)
1. `src/hooks/useEurUsdRate.ts`: the default becomes `'https://api.frankfurter.dev/v1/latest?base=USD&symbols=EUR'`
   and the comment above it names the move (the old host's 301 has no CORS header). `VITE_FX_RATES_URL` override,
   `fetchEurPerUsd` parsing and errors, query key, `staleTime`, `gcTime`, `retry` and the `EUR_PER_USD` fallback stay
   byte-identical. No new export.
2. `src/hooks/useEurUsdRate.test.ts` (Vitest, jsdom, `renderHook` from `@testing-library/react` inside a fresh
   `QueryClientProvider` with `retry: false` set on the client only, so the hook's own `retry: 1` is still what
   production uses; `vi.stubGlobal('fetch', vi.fn(...))`):
   - a `200` with `{rates: {EUR: 0.92}}` → `fetch` was called once with exactly
     `https://api.frankfurter.dev/v1/latest?base=USD&symbols=EUR`; `eurPerUsd` becomes `0.92`, `isLive` true.
   - a `200` without a valid `rates.EUR` → `eurPerUsd` stays `EUR_PER_USD`, `isError` true.
   - a non-ok response (`503`) → `eurPerUsd` stays `EUR_PER_USD`, `isError` true.
   Red on `origin/main` for the reason fixed: the first test's URL assertion fails (the hook calls the old URL);
   the two fallback tests pass on both (they pin today's behaviour).
3. Staging suite (rule 47, read-only): `tests/e2e/staging/vtid-<VTID>-wallet-fx-rate.staging.spec.ts` and
   `docs/validation/<VTID>/staging-tests.json` (`service: community-app`, one `kind: "playwright"` test). The spec
   signs in like the VTID-05288 spec (documented test user, REST sign-in on `/maxina`, then `about:blank`), opens
   `/wallet` at 1440×900 and at 390×844, waits for the `api.frankfurter.dev` response and asserts it is `200`, and
   asserts no console error, page error or failed request mentions `frankfurter` or `CORS`. It clicks nothing and
   sends no write; the runner's staging guard still aborts every non-GET to the gateway and Supabase. It never
   targets production.
## Lanes
- `fx-url` (vitana-v1, `executor: kiro`, seat `exafyltd` from `docs/programs/areas.yaml` area `frontend`): changes
  1-3 and `docs/validation/<VTID>/**`. `depends_on: []`. Shares no file with any open lane (no lane on `origin/main`
  lists these paths).
## Out of scope
- Wallet routes and screens (NEVER 26: no new wallet route; none is touched). Only the hook's default URL changes.
- A gateway FX proxy or another provider (the hook comment names that option; not needed while frankfurter.dev
  serves CORS).
- The VTID-05288 suite and the raw-palette findings of STAGING-VERIFY run 41300076673 (sidebar chrome, other plan).
## Test plan
- Lane: `npx vitest run src/hooks/useEurUsdRate.test.ts` fails on `origin/main` (URL assertion) and passes on the
  lane head; outputs in `docs/validation/<VTID>/red-on-base.txt` and `commands.log`. `npx eslint` on the two
  changed source files exits 0.
- Staging: the new suite passes in STAGING-VERIFY on the merge commit; until merge it is expected red on today's
  staging build (the old URL), which is the proof it detects the bug.
<!-- plan:end -->
