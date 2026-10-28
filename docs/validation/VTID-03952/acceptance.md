# VTID-03952 — Parallelize sequential auth reads in /auth/login and /auth/me

## Report

User-reported: login "takes forever" and shows a loading spinner "on every
step." Traced (with a companion `exafyltd/vitana-v1` frontend PR) to a
waterfall of sequential network calls rather than one slow request. This
PR is the backend half: `/auth/login` and `/auth/me` each awaited several
independent Supabase/PostgREST reads one after another instead of firing
them concurrently, and `/auth/login` additionally awaited a tenant lookup
and notification count solely to decide whether to fire calls that were
already fire-and-forget — blocking the response for no user-facing reason.

Scope is deliberately narrow: one file (`services/gateway/src/routes/auth.ts`),
reordering/deferring existing reads — no query, response shape, or
fallback-precedence change.

## Acceptance Criteria

AC-1 — `/auth/login`'s `app_users` and `users` profile reads
(`repo.fetchLoginProfile` / `repo.fetchUsersTableProfile`) run concurrently
via `Promise.all` instead of the `users` read only starting once
`app_users` resolves, and the merged `profile` object keeps the identical
precedence (app_users first, users only fills what app_users didn't
provide) and error-handling as the prior sequential code.

TEST: manual diff review, recorded in `commands.log` — confirms the
destructured `Promise.all` result is consumed in the same order/shape as
the two previously-sequential `await` calls it replaces. This session
could not run `tsc`/vitest locally (sandboxed environment, `npm ci` fails
with a 403 against `registry.npmjs.org` — see `commands.log`); this
workflow's own Build Gate step (`npm ci && npm run build`, same job) is
the first real compile check on this diff.

AC-2 — `/auth/login`'s tenant-membership lookup + welcome-notification
block (which only decides whether to fire the already-fire-and-forget
`notifyUserAsync`/`generatePersonalRecommendations`/`sendWelcomeChatMessages`/
`addUserToSystemGroups` calls) no longer blocks the HTTP response — it is
wrapped in a `void (async () => { ... })().catch(...)` IIFE and the
`return res.status(200).json(...)` runs immediately after the profile
fetch instead of waiting on it.

TEST: manual diff review — the wrapping IIFE follows the exact
fire-and-forget `.then()/.catch()` pattern already used by the calls
inside it (`notifyUserAsync`, `sendWelcomeChatMessages`), just applied one
level up to the whole block; a thrown error inside the IIFE is caught and
logged (`[VTID-01185] Post-login welcome/enrollment side effects failed`),
matching this file's existing error-logging convention rather than
crashing the process or silently swallowing the failure.

AC-3 — `/auth/me`'s four independent reads (`app_users` profile,
`profiles.vitana_id_locked`/`registration_seq`, `users` fallback,
`user_tenants` memberships) run concurrently via `Promise.all`; the
downstream AUTO-PROVISION safety net (`missingProfile`/`missingMembership`,
unchanged below this edit) still reads the correctly-named destructured
`profileData`/`profileError`/`membershipData`/`membershipError` values.

TEST: manual diff review — confirms variable names and read order into
`profile`/`memberships` are unchanged from the prior sequential version,
and that the two previously-`try/catch`-wrapped calls
(`fetchProfilesVitanaIdLock`, `fetchUsersTableProfile`) are now
`.catch()`-guarded on the `Promise.all` array entries instead, preserving
the same "never let a missing optional field fail the whole request"
behavior.

## Explicitly not covered

No route registration is added or removed by this diff (only the bodies
of the existing `router.post('/login', ...)` and `router.get('/me', ...)`
handlers changed), so no `ROUTE_MOUNT:`/`FINAL_URL:`/`CURL_PROOF:` evidence
is provided — inventing a curl proof for a route that already existed
before this change would not be real evidence.

No OASIS event emission is touched by this change (see `OASIS_IMPACT: no`
in the PR body).
