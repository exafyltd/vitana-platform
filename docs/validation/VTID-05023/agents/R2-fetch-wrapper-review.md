# VTID-05023 R2: review of the global fetch wrapper (MR !25)

Reviewed: branch `cutover/vtid-05023-C-rest-switch`, commit `53e8752023` (MR !25 head, state opened, not merged).
Files: `services/gateway/src/lib/data-rest-base.ts`, `services/gateway/src/index.ts:10`, `services/gateway/test/vtid-05023-data-rest-base.test.ts`, and the coder's note `docs/validation/VTID-05023/agents/C.md`.

## Evidence

- Recorded by the coder (C.md): `jest test/vtid-05023-data-rest-base.test.ts` 18 of 18 pass; `tsc --noEmit` exits 0. Not run: the full gateway Jest suite, and a live `/alive` check. Not rerun here.
- Spot checks made by this review:
  - supabase-js 2.80.0 (`dist/main/lib/fetch.js`, lines 4-8): `resolveFetch` returns `(...args) => fetch(...args)`, so the global `fetch` is looked up on every call. Its REST client uses `new URL('rest/v1', baseUrl).href` (`SupabaseClient.js:66`). Supabase-js REST calls therefore go through the wrapper.
  - node-fetch 3.3.2 (`src/index.js:9`) imports `node:http`. It never calls `globalThis.fetch`, so the wrapper cannot see its calls.
  - Request clone with a stream body: no failure on Node 22. The gateway has no `new Request(` outside the wrapper, so this edge is not reachable.

## Which calls are rewritten

A call is rewritten only when `aurora_proxy` mode is set and the URL (string, `URL`, or `Request.url`) is exactly `${S}/rest/v1`, or starts with `${S}/rest/v1/` or `${S}/rest/v1?`. `S` is `SUPABASE_URL` with trailing slashes removed (`data-rest-base.ts:68-75`). The prefix is replaced with `${DATA_REST_PROXY_URL}/rest/v1`.

Not rewritten: `/auth/v1`, `/storage/v1`, `/functions/v1`, `/rest/v1x`, other hosts, and every call in `supabase` mode (the install returns before touching `fetch`, line 84).

## Which other code paths are affected

- Every `globalThis.fetch` call in the gateway process passes through the wrapper once installed (`index.ts:10`). Only the path check decides whether a call changes.
- Not covered: every module that imports `node-fetch` and calls `${SUPABASE_URL}/rest/v1`. See blocker B1.
- Not covered: the job entry point `dist/job-entry.js` (`Dockerfile.job:49`). It never calls `installDataRestRouting()`. Its REST calls stay on Supabase in any mode. This branch sets no mode for the job, and the job image is built by a GitHub workflow outside this cutover, so this is a decision for the owner, not a blocker here (see note N1).

## Method, headers, body, signal, redirect

- String and `URL` input: `init` is passed through unchanged (lines 94, 98). Method, headers, body, signal and redirect are preserved.
- `Request` input (line 102): `new Request(rewritten, input)` copies the method, headers, body, signal and redirect. The caller's `init` still applies on top. The test at lines 128-140 of the test file checks the rewritten URL and the method. It does not assert the body, signal or redirect. The code path preserves them, so this is a test gap, not a defect. The body assertion should be added.

## What breaks if the rewrite is wrong

- Missed rewrite (REST goes to Supabase while the mode says proxy): the 50 gateway call sites in B1. They read and write Supabase while the other calls go to Aurora. For example, VTID allocation (`operator-service.ts:647` `rpc/allocate_global_vtid`, `:770` `rpc/next_vtid`) and ledger writes (`:829`) would land in a different store from the one the rest of the gateway reads. In a cutover this can give duplicate or missing VTIDs and split `oasis_events`.
- Wrong rewrite (non-REST traffic goes to the proxy): not reachable with the match rule above. `/auth/v1` and other prefixes are untouched.
- Misconfigured `DATA_REST_PROXY_URL`: the value is only checked for being non-empty (`data-rest-base.ts:55-58`). REST requests from the process carry `apikey` and `Authorization` headers with the Supabase service role key (`SUPABASE_SERVICE_ROLE`), so a wrong host receives that key. See note N2.
- `SUPABASE_URL` unset in `aurora_proxy` mode: the rewrite returns the URL unchanged (line 71). Not reported as a blocker, because staging requires `SUPABASE_URL` elsewhere.

## Re-install

- A second install in `aurora_proxy` mode returns early (line 90), because the wrapper carries the `Symbol.for('vitana.data-rest-base.wrapped')` marker. The first install's env reference is kept. The test at test-file lines 150-160 covers this.
- No recursion: the wrapper calls the captured `original`, not `globalThis.fetch`.
- A wrapper added on top by another library is safe. Rewriting is idempotent, because a rewritten URL no longer starts with the Supabase REST prefix. The only exception is `DATA_REST_PROXY_URL` equal to `SUPABASE_URL`, which makes the rewrite an identity.

## Blockers

### B1: node-fetch REST callers bypass the wrapper

Evidence (`services/gateway/src/...`). Each file imports `fetch` from `node-fetch`, and each listed line calls `${SUPABASE_URL}/rest/v1`:

| File | Import line | REST call lines | Count |
|---|---|---|---|
| `services/operator-service.ts` | 11 | 169, 205, 272, 335, 349, 466, 509, 552, 647, 770, 829, 900, 952, 1111, 1149, 1327, 1387, 1423, 1657 | 19 |
| `services/gemini-operator.ts` | 26 | 1232, 1274, 1948, 2092, 3290, 3312, 3351, 3418, 3480, 3502, 5307, 5320, 5376, 5384, 5391, 5446, 5504, 5767, 5934 | 19 |
| `services/validator-core-service.ts` | 23 | 133, 435, 498, 539 | 4 |
| `services/worker-core-service.ts` | 17 | 129, 550, 616, 651 | 4 |
| `services/ledger-task-dedup.ts` | 25 | 73, 129 | 2 |
| `services/knowledge-hub.ts` | 13 | 80 | 1 |
| `services/operator-planner.ts` | 39 | 74 | 1 |
| `scripts/repair-vtid-0541.ts` | 14 | 57, 80, 105 | 3 (CLI script) |

Reachability (checked, not assumed):
- `routes/operator.ts:74,91` imports `operator-service`. The router is mounted at `/api/v1/operator` (`index.ts:901`).
- `routes/autopilot.ts:62,69,74` imports `operator-service`, `worker-core-service` and `validator-core-service`. The router is mounted at `/api/v1/autopilot` (`index.ts:919`).
- `routes/operator.ts:37` and `routes/conversation.ts:70` import `gemini-operator`. `routes/assistant.ts:35` imports `knowledge-hub`.
- No alias or shim maps `node-fetch` to the global fetch: `tsconfig.json`, `jest.config.js` and `package.json` have none.

User-visible consequence: in `aurora_proxy` mode, operator and autopilot endpoints read and write Supabase while other endpoints read and write Aurora. The coder's claim in C.md ("The one wrapper point covers all of them") is wrong for these 50 gateway call sites.

Required correction:
1. In the 7 gateway modules above, delete the `import fetch from 'node-fetch';` line so the global fetch is used. The runtime is Node 20 (`Dockerfile:1`), and `package.json` declares `node >=18`. None of these files uses a node-fetch-only API (checked: no `.buffer()`, no body stream piping, no `FormData`). Keep the `node-fetch` dependency, because `routes/gateway-events-api.ts` and `services/natural-language-service.ts` still import it.
2. For `scripts/repair-vtid-0541.ts`, make the same change, or state in the script header that it stays on Supabase.
3. Add a regression test that fails if a file under `src` both contains `SUPABASE_URL}/rest/v1` and imports `node-fetch`. Also add one behavioural test: in `aurora_proxy` mode, call one `operator-service` function that performs a REST call, with a mocked global fetch, and assert the URL starts with the proxy base.
4. Correct the C.md claim to match the final code.
5. Run the full gateway Jest suite and `tsc --noEmit` before merge, because the wrapper now affects every outbound fetch in the process.

## Non-blocking notes (no change required for this MR)

- N1, job entry point: `dist/job-entry.js` does not install the wrapper. If the owner flips `DATA_REST_BASE_MODE` for the executor job later, the job needs the same install call (`job-entry.ts` imports). Decide before that flip.
- N2, proxy trust: the proxy receives the service role key on every REST call. The proxy host must be internal and owner-controlled. Consider rejecting a `DATA_REST_PROXY_URL` that is not an internal host.

## How to test

- Recorded: the 18 unit tests in `test/vtid-05023-data-rest-base.test.ts` (run by the coder).
- Add the B1 regression tests above.
- Staging, after the fix: in `aurora_proxy` mode, call `POST /api/v1/operator` (allocation path) and confirm the proxy access log shows `rpc/allocate_global_vtid` or `rpc/next_vtid`, and that the Supabase REST logs show no matching request from the gateway.

## Verdict

CHANGES REQUESTED. Blocker B1 must be fixed before this MR is merged. Once B1 is fixed and the listed tests pass, the wrapper itself is safe for the calls it covers.

```json
{
  "verdict": "CHANGES_REQUESTED",
  "findings": [
    {
      "id": "B1",
      "severity": "blocker",
      "title": "node-fetch REST callers bypass the global fetch wrapper",
      "files": [
        "services/gateway/src/services/operator-service.ts:11,169,205,647,770,829",
        "services/gateway/src/services/gemini-operator.ts:26,1232",
        "services/gateway/src/services/validator-core-service.ts:23,133,435",
        "services/gateway/src/services/worker-core-service.ts:17,129,550",
        "services/gateway/src/services/ledger-task-dedup.ts:25,73,129",
        "services/gateway/src/services/knowledge-hub.ts:13,80",
        "services/gateway/src/services/operator-planner.ts:39,74",
        "services/gateway/src/scripts/repair-vtid-0541.ts:14,57,80,105"
      ],
      "consequence": "In aurora_proxy mode, operator and autopilot REST calls (50 gateway call sites) go to Supabase while the rest of the process goes to the proxy, splitting VTID allocation and oasis_events between stores.",
      "required_change": "Remove the node-fetch import from the gateway modules that call REST so the global fetch is used; add a regression guard test for node-fetch plus SUPABASE_URL/rest/v1; correct C.md; run the full gateway Jest suite and tsc before merge."
    }
  ]
}
```
