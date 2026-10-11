# Bearer-authenticated task reads and access-denied stop for the dev task board (VTID-05063, vitana-v1 half of step A)

The change makes the two gateway GETs in `src/lib/taskApi.ts` (`fetchTasks`, `pollTasks`) send the signed-in user's Supabase access token, so `/dev/command`'s task board keeps working once the gateway enforces `LEDGER_READ_AUTH_MODE=enforce` on `GET /api/v1/tasks`. Both reads now share one helper that copies `adminFetch`'s token lookup, sends nothing when there is no session, and returns a typed `TaskReadResult` in which 401 and 403 become `access_denied`. `useTaskStream` stops its 10 s polling loop for good on `access_denied` and exposes `{ accessDenied }`, which `TasksView` uses to show an alert in place of the empty board. This matches plan section 2d and finding F9 with no scope creep: the POST, PATCH and DELETE functions and the EventSource handling are the same as the base. Reviewed by reading only. Nothing was run.

Watch for: other importers of `fetchTasks`/`pollTasks` were not ruled out because the worktree cannot be searched (possible). The new i18n values and JSON validity in the 11 locale files were not read (possible). The i18n audit/stamp and SCREEN_INVENTORY steps are still pending in CI.

**Verdict**: APPROVED

## High-level view

The read path now matches the plan. `readTasks` calls `supabase.auth.getSession()` and returns `signed_out` with no network call when there is no access token. When there is a token it sends `Authorization: Bearer <access_token>` and keeps the base's `credentials: "include"` and URLs. It maps 401 and 403 to `access_denied`, and any other non-2xx or thrown error to `error`. The two exported functions are now thin wrappers, so the bearer logic exists in one place. The write-side functions are byte-for-byte the base.

The hook stops polling on the first `access_denied`, whether it comes from the initial fetch or from a poll, and never restarts. A `denied` flag in the effect closure blocks `startPolling`, which the stream's `onerror` timer still calls. `signed_out` and `error` keep the base behaviour: an empty list on the first load and continued polling. The only change to the EventSource block is that `stopPolling` moved above its first use. Stream reconnects to the nonexistent `/api/v1/tasks/stream` keep going after denial, as they do on the base. The plan scoped the stop to polling only, so this is out of scope.

The vitest suite covers every case the plan names: the bearer on both fetch and poll, no request when signed out, and 401 and 403 each stopping polling for at least 60 s afterwards. It also covers a denied first read never starting polling, and polling continuing while access is granted.

What could not be checked by reading is outside the four reviewed source files. The worktree is outside the searchable workspace, so other importers of the changed return types and the content of the 11 locale catalogs are unverified.

<details>
<summary>Issues (3)</summary>

1. **Unverified other importers of the read functions**: `fetchTasks`/`pollTasks` changed from `Promise<Task[]>` to `Promise<TaskReadResult>`, and only `useTaskStream` is known to call them (possible). Run `git grep -n -E "fetchTasks|pollTasks" src` before merge, or rely on a typecheck that actually runs `tsc` (a Vite build alone does not type-check).
2. **Locale values not read**: the coder confirmed the keys `screens.dev.taskBoardAccessDenied` and `screens.dev.taskBoardAccessDeniedDescription` exist once in each of the 11 `screens.json` files, but the values and JSON validity were not viewed (possible). Rely on the CI i18n audit, the stamp/staleness check and JSON parsing in `npm run test:unit`/build, and stamp the keys if the audit asks.
3. **Repo bookkeeping still open**: `npm run i18n:inventory` and committing the regenerated `docs/SCREEN_INVENTORY.md` have not been done (confirmed from the coder report). Do both in the commit that ships this change.

</details>

<details>
<summary>Details</summary>

### Bearer attachment mirrors adminFetch

Where `adminFetch` throws `NO_AUTH_TOKEN`, `readTasks` returns `signed_out` before any `fetch`. Using `getSession()` rather than a cached token helper has a side effect that matters here. Each 10 s poll goes through supabase-js's own expiry and refresh handling, so an expired token is refreshed before the read. Otherwise it would produce a 401, and under this design a 401 stops polling permanently.

`credentials: "include"` is kept next to the new header. The base already sent `Content-Type: application/json`, so the request was already preflighted. `Authorization` only adds to `Access-Control-Request-Headers`, which plan 2d records as allowed by `middleware/cors.ts:67`.

### access_denied as a terminal state in useTaskStream

```
fetchTasks ──access_denied──► denyAccess() ─► denied=true, clearInterval, setAccessDenied(true)
pollTasks  ──access_denied──┘
stream onerror ─(10 s)─► startPolling()  ── returns early if denied
```

Within the four files, the union narrowing on `ok` type-checks for both callers. Denial lasts for the component's lifetime: a user who is granted `exafy_admin` later has to remount the view. That follows the plan's "stop polling" wording. Because `TasksView` hides `TaskConnectionStatus` in the denied state, the stream's continuing `RECONNECTING` state is not shown next to the denial message.

### Test coverage

The suite matches the repo's vitest setup: the `src/**/*.test.ts` include, jsdom, a `vi.hoisted` Supabase mock, `vi.stubGlobal` for `fetch`/`EventSource`, and fake timers driven inside `act`.

Not tested: the `TasksView` rendering of the alert, which is covered only through the hook's `accessDenied` flag, and the `signed_out` path inside the hook, where polling continues while no request is sent. Neither is required by the plan.

</details>

<details>
<summary>File map</summary>

- `src/lib/taskApi.ts`: new `TaskReadResult` type and `readTasks` helper. `fetchTasks`/`pollTasks` send the Supabase bearer, skip when signed out, and map 401/403 to `access_denied`. Write functions unchanged.
- `src/hooks/useTaskStream.ts`: returns `{ accessDenied }`, adds `denyAccess`, and blocks `startPolling` after denial. EventSource block unchanged.
- `src/components/dev/TasksView.tsx`: renders a header plus a destructive `Alert` when `accessDenied` is set.
- `src/i18n/{de,en,es,sr,fr,pt,ru,pl,ar,zh,tr}/screens.json`: adds `screens.dev.taskBoardAccessDenied` and `...Description`. Values not viewed in this review.
- `src/hooks/useTaskStream.vtid-05063.test.ts` (new): vitest for the bearer, signed-out, 401/403 and polling-stop behaviour.

Full diff: `git diff 258e3c2a3` in `c:\Users\dstev\vitana-v1\.worktrees\vtid-05063-taskapi-auth`.

</details>
