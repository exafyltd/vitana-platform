# VTID-05023 agent C: REST base switch

Branch: `cutover/vtid-05023-C-rest-switch` (from `origin/main` a02b8918).

## What changed

- `services/gateway/src/lib/data-rest-base.ts` (new):
  - `DATA_REST_BASE_MODE`: `supabase` (default when unset or empty) or `aurora_proxy`.
  - `DATA_REST_PROXY_URL`: the REST proxy base, used only in `aurora_proxy` mode. The staging deploy job does not resolve a proxy URL secret today, so this is a plain env var that the task definition must carry.
  - `getSupabaseAuthBase()` returns `SUPABASE_URL` in both modes. AUTH never reads the mode.
  - `installDataRestRouting()` wraps `globalThis.fetch` in `aurora_proxy` mode only. It rewrites URLs that start with `${SUPABASE_URL}/rest/v1` (exact prefix, so `/rest/v1x` does not match) to the proxy. Every other URL, including `/auth/v1`, passes through unchanged. In `supabase` mode it does not touch `fetch`.
- `services/gateway/src/index.ts`: calls `installDataRestRouting()` once, right after the imports.
- `services/gateway/test/vtid-05023-data-rest-base.test.ts` (new): 18 tests.

## Design choices

- The gateway builds REST URLs from `SUPABASE_URL` at about 1,000 call sites in 190 files. Editing each site was too broad. The one wrapper point covers all of them, including the `supabase-js` clients, which use global `fetch`.
- Unknown `DATA_REST_BASE_MODE` values throw at boot, so the process does not start. The deploy smoke check then rolls back. I chose this over falling back to Supabase, because a typo in the cutover switch should fail loudly, not quietly keep traffic on the old backend.
- `aurora_proxy` without `DATA_REST_PROXY_URL` also throws at boot.

## Test output

Command: `cd services/gateway && npx jest test/vtid-05023-data-rest-base.test.ts`

```
PASS test/vtid-05023-data-rest-base.test.ts
  VTID-05023 DATA_REST_BASE_MODE
    mode selection
      ✓ defaults to supabase when DATA_REST_BASE_MODE is unset (17 ms)
      ✓ treats an empty or whitespace value as unset (1 ms)
      ✓ accepts aurora_proxy (1 ms)
      ✓ fails closed on an unknown value (14 ms)
      ✓ refuses to install routing for an unknown value (1 ms)
    REST base
      ✓ default unset: REST base is SUPABASE_URL, exactly as before
      ✓ aurora_proxy: REST base is the proxy URL
      ✓ aurora_proxy without DATA_REST_PROXY_URL throws (1 ms)
      ✓ aurora_proxy changes only the REST base: rewrites /rest/v1 and nothing else (1 ms)
      ✓ supabase mode: rewriteRestUrl is the identity
    AUTH stays on Supabase in both modes
      ✓ auth base is SUPABASE_URL in supabase mode (1 ms)
      ✓ auth base is SUPABASE_URL in aurora_proxy mode
      ✓ supabase mode: /auth/v1 calls go to Supabase unchanged (1 ms)
      ✓ aurora_proxy mode: /auth/v1 calls go to Supabase unchanged
      ✓ aurora_proxy: the installed fetch sends auth to Supabase and REST to the proxy (3 ms)
      ✓ aurora_proxy: a Request object for /rest/v1 is rerouted and keeps its method and body (3 ms)
      ✓ supabase mode: installing routing leaves fetch untouched
      ✓ aurora_proxy: installing twice does not double-wrap
Test Suites: 1 passed, 1 total
Tests:       18 passed, 18 total
```

Type check: `npx tsc --noEmit -p tsconfig.json` exits 0.

## Not verified here

- `/alive` and `/api/v1/admin/build-info` were not run against a live server. Neither the local suite nor the gateway tests import `src/index.ts`. Check both after the staging deploy.
- The full gateway Jest suite was not run. Only the new suite covers the changed code.

## Staging mode

Set in a separate MR from `cutover/vtid-05023-C-staging-aurora-mode`. That MR is not merged in this run, because the staging proxy URL is not verified yet (agent H).
