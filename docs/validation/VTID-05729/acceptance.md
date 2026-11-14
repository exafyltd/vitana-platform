# VTID-05729 — Gate the semantic memory write routes (plan gateway-critical-route-auth, lane semantic-memory-auth)

Pin: vitana-platform `origin/main` `6dc6e1ba0c`. Plan: `.kiro/specs/gateway-critical-route-auth/plan.md` §2 and §4 on
branch `kiro/gateway-critical-route-auth/plan`.

Before this change, `POST /api/v1/memory/semantic/search`, `/write` and `/context` took `lens.tenant_id` and
`lens.user_id` from the request body and passed them to services that use the service-role client, with no auth.
Anyone could read or write any user's memory by naming their ids. `POST /admin/embeddings/generate` and `/reembed`
were also open.

## What changed (`services/gateway/src/routes/semantic-memory.ts`)

- `requireAuthWithTenant` (existing, `middleware/auth-supabase-jwt.ts:748`) is the first middleware of
  `POST /semantic/search`, `/semantic/write` and `/semantic/context`.
- New helper `resolveCallerLens()` builds the lens:
  - `tenant_id` comes from `req.identity.tenant_id` (the token tenant after the membership check, or the primary tenant
    that `requireAuthWithTenant` writes back into `req.identity.tenant_id`).
  - `user_id` comes from `req.identity.user_id`.
  - `workspace_scope`, `active_role`, `allowed_categories`, `visibility_scope` and `max_age_hours` come from the body
    lens if given. `workspace_scope` defaults to `product`.
- The body `lens` is now optional. If it carries a `tenant_id` or `user_id` that differs from the caller's, the route
  answers 403 `{ ok: false, error: 'LENS_MISMATCH' }` before any embedding or memory service call.
- `exafy_admin` gets no override on these three routes. An admin cannot read or write another user's memory through them.
- `requireAdminAuth` (existing, `auth-supabase-jwt.ts:831`) is the first middleware of `POST /admin/embeddings/generate`,
  `POST /admin/embeddings/reembed` and `GET /admin/embeddings/status`.
- `GET /semantic/health` is unchanged (open).
- The unused helpers `isDevSandbox()` and `getLensFromRequest()` were removed. No route called them on the pin. The
  `createDevSandboxLens` import went with them, and so did the strict `ContextLensSchema`, which `CallerLensSchema`
  replaces.
- No new middleware, migration, secret or flag.

## Acceptance criteria

AC-1 With no token, all five write routes (`/semantic/search`, `/semantic/write`, `/semantic/context`,
`/admin/embeddings/generate`, `/admin/embeddings/reembed`) answer 401, and no service is called.
TEST: services/gateway/test/semantic-memory-auth.test.ts ("no token → 401 on every write route")

AC-2 An authenticated caller (user A, tenant T) whose body lens names user B or another tenant gets 403 `LENS_MISMATCH`.
`semanticSearch`, `writeMemoryItem`, `buildSemanticContext` and the embedder are not called.
TEST: services/gateway/test/semantic-memory-auth.test.ts ("body lens naming another user/tenant → 403 LENS_MISMATCH")

AC-3 An `exafy_admin` caller whose body lens names another user also gets 403 `LENS_MISMATCH`. There is no admin override
on these routes.
TEST: services/gateway/test/semantic-memory-auth.test.ts ("as exafy_admin with lens.user_id = B → 403")

AC-4 With no body lens, or a lens without ids, the service receives `tenant_id` T, `user_id` A and `workspace_scope`
`product`. A lens carrying the caller's own ids keeps its other fields (`workspace_scope`, `active_role`,
`allowed_categories`).
TEST: services/gateway/test/semantic-memory-auth.test.ts ("lens ids come from the identity")

AC-5 A non-admin on `POST /admin/embeddings/generate`, `POST /admin/embeddings/reembed` or `GET /admin/embeddings/status`
gets 403 and no service call; `GET /admin/embeddings/status` with no token gets 401. For an admin, the handler runs.
TEST: services/gateway/test/semantic-memory-auth.test.ts ("admin embedding routes require exafy_admin")

## Evidence (local, sandbox)

- New test with the route file from `origin/main` swapped in: 24 failed, 6 passed, 30 total
  (`outputs/jest-red-on-base.txt`). The 6 that pass on the base are the allowed-caller cases (own ids with extra lens
  fields on the three user routes, and admin on the three admin routes), which the open base also serves.
- New test on this change: 30 passed, 30 total (`outputs/jest-green.txt`).
- `npx tsc --noEmit --preserveSymlinks`: exit 0 (`outputs/tsc-gateway.txt`). `--preserveSymlinks` is needed because
  the sandbox's `services/gateway/node_modules` is a symlink to another worktree; without it, `declaration: true` gives
  59 `TS2742` errors in files outside this lane, identical on the base.
- Existing tests (`outputs/jest-existing.txt`): `test/routes/semantic-memory.test.ts` (26),
  `test/services/supabase-semantic-memory.test.ts`, `test/memory.test.ts` and `test/memory-confidence.test.ts` pass,
  209 passed, 209 total.
- `test/routes/semantic-memory.test.ts` was updated to the authenticated contract (outside plan §4's path list; done on
  the owner's instruction for this pass):
  - it mocks `middleware/auth-supabase-jwt` like the new test (tokens `user-a`, `user-b`, `admin`) and sends a token on
    every request except the health check;
  - the three "no lens → 400" cases were anonymous requests; they now assert 401 and still assert no service call;
  - "non-UUID lens ids → 400 VALIDATION_ERROR" now asserts 403 `LENS_MISMATCH` (ids that are not the caller's) and
    still asserts no service call;
  - the three lens-forwarding cases send a body lens without ids and still assert the service receives tenant A /
    user A, so the ids can only come from the identity; "never mixes tenants" uses two callers (A and B) and now also
    checks `user_id`;
  - every other assertion is unchanged. The admin cases send the admin token.
  - With the base route file swapped in, the updated file fails 7 of 26 (`outputs/jest-existing-routes-on-base.txt`):
    the 3 anonymous-401 cases, the `LENS_MISMATCH` case, and the 3 identity-lens cases.

## Callers (census, see `commands.log`)

The platform has no in-repo caller of the five write routes, and vitana-v1 (`origin/main` `e31bf462`) has none either.
The only references outside the route file and its tests are:
- the health URL `/api/v1/memory/semantic/health` (GET, unchanged);
- the route inventory `scripts/mt/inventory/data/routes.json`.

Callers outside both repositories are unknown.

## Not yet observed (staging / production)

- Staging: not deployed and not probed. `staging-tests.json` lists rejected probes only. Each of the four POSTs and
  `GET /api/v1/memory/admin/embeddings/status` without a token should return 401.
- Production: not deployed. No production caller logs were read. A production caller of these routes that sends no
  token, or sends another user's lens, will start getting 401 or 403 (plan §8). A PUBLISH needs the owner's reading of the
  gateway request logs for `/api/v1/memory/semantic/*` and `/api/v1/memory/admin/embeddings/*` first.
- STAGING-VERIFY run id: none yet.

## Route mount evidence (Validator Check)
No route is added: the routes and their mounts exist on `main`; the change inserts a middleware or verification into existing registrations.
ROUTE_MOUNT: unchanged — `services/gateway/src/index.ts:1209` (`/api/v1/memory`)
FINAL_URL: POST /api/v1/memory/semantic/search, /semantic/write, /semantic/context; POST /api/v1/memory/admin/embeddings/generate, /reembed; GET /api/v1/memory/admin/embeddings/status (paths unchanged)
CURL_PROOF: not run. No live or staging request was made; the staging proof is `staging-tests.json`, run by STAGING-VERIFY after a staging deploy, recorded here only with a run id.
