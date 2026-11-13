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

- The gateway builds REST URLs from `SUPABASE_URL` at about 1,000 call sites in 190 files. Editing each site was too broad. The wrapper covers every call that goes through the global `fetch`, including the `supabase-js` clients. It does not cover a module that imports `node-fetch`, because node-fetch never calls `globalThis.fetch`. See the correction below.
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

## Correction after review R2

The claim that one wrapper point covers all REST calls was wrong. Seven gateway modules and `scripts/repair-vtid-0541.ts` imported `node-fetch` and built `${SUPABASE_URL}/rest/v1` URLs. Those calls bypassed the wrapper, so in `aurora_proxy` mode operator and autopilot read and wrote Supabase. Fixed by removing the `node-fetch` import from:

- `services/gateway/src/services/operator-service.ts`
- `services/gateway/src/services/gemini-operator.ts`
- `services/gateway/src/services/validator-core-service.ts`
- `services/gateway/src/services/worker-core-service.ts`
- `services/gateway/src/services/ledger-task-dedup.ts`
- `services/gateway/src/services/knowledge-hub.ts`
- `services/gateway/src/services/operator-planner.ts`

None of these files used a node-fetch-only API (`.buffer()`, body piping, `FormData`, `timeout` or `agent` options). They now use the global `fetch`. `node-fetch` stays in `package.json`, because `routes/gateway-events-api.ts` and `services/natural-language-service.ts` still import it. Those two files do not build `/rest/v1` URLs.

`scripts/repair-vtid-0541.ts` also lost its `node-fetch` import. It stays on Supabase on purpose: it is a standalone CLI that never calls `installDataRestRouting()`, and its header says so.

Still not covered: `dist/job-entry.js` never calls `installDataRestRouting()`, so its REST calls stay on Supabase in any mode. This is an open decision for the owner before `DATA_REST_BASE_MODE` is changed for the executor job.

### Proxy host rule

In `aurora_proxy` mode, `DATA_REST_PROXY_URL` is checked at boot. The URL must parse, use http or https, and have an internal host: a host ending in `.internal` (this includes `.vitana.internal`), or a private IPv4 literal (10.x, 172.16-31.x, 192.168.x, 127.x). Any other host fails closed with an error, and the process does not start. In `supabase` mode the setting is not checked.

### Tests added

- `test/vtid-05023-no-node-fetch-rest.test.ts`: fails if a file under `src` contains `SUPABASE_URL}/rest/v1` and imports `node-fetch`.
- `test/vtid-05023-operator-rest-routing.test.ts`: in `aurora_proxy` mode, `ingestOperatorEvent` sends its REST call to the proxy, and the `/auth/v1` call stays on `SUPABASE_URL`.
- `test/vtid-05023-data-rest-base.test.ts`: new cases for internal, public, unset and malformed proxy URLs.

Seven existing suites mocked `node-fetch` for calls that now use the global fetch. Their mocks now point at `globalThis.fetch`, and their assertions are unchanged. `vtid-03835-operator-console-read-tools.test.ts` also mocks `oasis-event-service`, because the tool-call telemetry POST would otherwise count in its "never called" assertions.

Full gateway suite (`npx jest --silent`): 29745 tests passed, 2 failed, 54 skipped. The 2 failures are the known sandbox-only ones: `test/providers/storage-provider.test.ts` (AWS_REGION) and `test/vtid-04226-eventbridge-test-contract-schedules.test.ts` (openssl not installed). `npx tsc --noEmit` exits 0.

## Not verified here

- `/alive` and `/api/v1/admin/build-info` were not run against a live server. Neither the local suite nor the gateway tests import `src/index.ts`. Check both after the staging deploy.
- The full gateway Jest suite is covered in the R2 fix below.

## Staging mode

Set in a separate MR from `cutover/vtid-05023-C-staging-aurora-mode`. That MR is not merged in this run, because the staging proxy URL is not verified yet (agent H).
