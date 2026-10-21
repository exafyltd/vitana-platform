# VTID-03744 — Acceptance (admin feature-announcements: await notification dispatch)

Scope of THIS PR: gateway-only. `POST /api/v1/admin/feature-announcements`
(publishes News Feed "Brand New Feature" / "Did You Know" cards) fanned out
its notification via `notifyUsersAsync` — fire-and-forget. The sibling
`daily-feature-tip` cron route had exactly this shape of bug: an un-awaited
dispatch left in flight when the process was recycled right after the HTTP
response, delivering to only a fraction of recipients (33/181 observed live
in production, fixed in PR #2986 by awaiting dispatch via
`Promise.allSettled`). This route sends to the same scale of audience (the
whole tenant) and was about to be used again for a new "Reply & Like
Comments" announcement, so it gets the identical fix now rather than
reproducing the failure.

Change: `notifyUsersAsync(userIds, ...)` → one awaited `notifyUser(uid, ...)`
call per recipient, all wrapped in `Promise.allSettled`. `notified_at` is
written only after that `Promise.allSettled` resolves. The response and the
OASIS publish-event payload both gained a `dispatched` count (calls that
actually completed) alongside the existing `sent_to` count (calls attempted).

AC-1 — Notification dispatch is awaited via `Promise.allSettled` over
per-recipient `notifyUser` calls, not fire-and-forget `notifyUsersAsync`
  TEST: services/gateway/test/admin-feature-announcements.test.ts
        ("publishes tenant-wide and notifies every member" — asserts
        notifyUserMock was called once per recipient, not once per locale
        group)

AC-2 — A single rejected `notifyUser` call does not block dispatch to the
other recipients, and the response's `dispatched` count reflects only the
calls that actually completed (not the count attempted)
  TEST: services/gateway/test/admin-feature-announcements.test.ts
        ("one rejected notifyUser call does not block or miscount the
        others (Promise.allSettled)")

AC-3 — The staged test-send path (`recipient_ids`) still dispatches via the
same awaited per-recipient call and reports `dispatched: 1`
  TEST: services/gateway/test/admin-feature-announcements.test.ts
        ("staged test send scopes to recipient_ids and skips the
        tenant-wide lookup")

AC-4 — Existing auth/validation/error-path behavior is unchanged by this
refactor (401 no token, 403 non-admin, 400 missing fields / unknown variant,
500 on insert failure)
  TEST: services/gateway/test/admin-feature-announcements.test.ts
        (describe blocks "— auth", "— validation", "— error path"; none of
        these bodies were touched by this PR)

## Not independently confirmed

This session has no network access to install `services/gateway/node_modules`
(`npm ci` returns 403 from `registry.npmjs.org` — same sandbox limitation
noted in the original PR #2922 that added this route), so `tsc --noEmit` and
`jest` could not be run locally here. The signature match against
`notifyUser`'s real export (`services/gateway/src/services/notification-service.ts:684`)
was checked by reading the source directly. CI's own Build Gate step
(`npm ci && npm run build`) is the first real compile of this diff; the
Acceptance Mapping Gate's `TEST:` tokens above point at real, already-written
test cases for a reviewer/CI to execute, not at output this session produced.
