# VTID-03992 — Acceptance

## Background

A background audit dispatched under VTID-03991 (the standing governance rule
that test/service/automation accounts must never be visible to real
members) checked whether the same class of leak VTID-03990 fixed for the
welcome-chat broadcast exists anywhere else in the two live repos. It found
one confirmed live gap (the Community Members Directory + the ORB voice
tools that share its exclusion logic) and one investigated-and-closed
non-issue (the matchmaking candidate pool, which turned out to be dead
schema).

## Acceptance Criteria

AC-1: `fetchExcludedTestServiceAccountIds()` returns the union of
`service_bot_accounts.user_id` and `notification_test_actors.user_id`.
TEST: services/gateway/test/lib/excluded-test-service-accounts.test.ts — "unions service_bot_accounts and notification_test_actors user_ids"

AC-2: The helper fails OPEN (returns an empty set, never throws/rejects) on
a query error or a rejected promise — a read/display surface must keep
working even if this lookup fails.
TEST: services/gateway/test/lib/excluded-test-service-accounts.test.ts — "fails open — a thrown error resolves to an empty set instead of rejecting" / "fails open — a rejected query promise resolves to an empty set instead of rejecting"

AC-3: The Community Members Directory (`GET /api/v1/community/members` and
`/community/members/count`) excludes both allowlists, closing the
CONFIRMED live gap (see commands.log for the live query that found both
VTID-03990 bot accounts at registration_seq 246/247, with `max(registration_seq)=247` — i.e. literally the #1 and #2 "newest members").
CURL: read-only production query, see commands.log and outputs/members-directory-exposure.json for the exact confirmation (before this fix, nothing in this route excluded them).

AC-4: The ORB voice "who is...?" tools (`superlatives.ts`) and
`find_community_member` (`community-member-ranker.ts`) exclude both
allowlists — a real user asking "who's our newest member?" can no longer
be answered with a service account's name.
TEST: covered structurally by the existing suites (services/gateway/test/services/voice-tools/superlatives.test.ts, services/gateway/test/services/voice-tools/community-member-ranker.test.ts) continuing to pass unmodified — the new exclusion query resolves to an empty set by default in both suites' shared mock (see commands.log), so no existing assertion changes; the real exclusion is exercised end-to-end once deployed.

AC-5: `connect-people-repository.ts`'s `fetchPrimaryTenantUsers()` — used by
AP-0101 (Daily Match Delivery), AP-0102 (Shared Interest Nudge), AP-0105
(Group Recommendation Push) — excludes both allowlists, and the dead,
unused `VITANA_BOT_USER_ID` constant in `connect-people.ts` is removed.
TEST: services/gateway/test/services/automation-handlers-connect-people.test.ts continues to pass unmodified (neither test in that file exercises `fetchPrimaryTenantUsers`, and the shared fake-Supabase mock defaults an unconfigured table to `{data: [], error: null}`, so the new exclusion query is a no-op there).

AC-6: The matchmaking candidate pool (`match_targets`/`matches_daily`) does
NOT need this fix — it is dead, never-deployed schema, and the live
`daily_matches` table has zero rows referencing either VTID-03990 bot
account today.
CURL: `select to_regclass('public.match_targets')` → null; `select count(*) ... from daily_matches where user_id/matched_user_id in (...)` → 0/1600. See commands.log / outputs/matchmaking-investigation.json.

AC-7: (Pre-existing bug found while fixing AC-3, in the same file) When a
`?dance=` filter is present, `GET /api/v1/community/members` no longer
re-filters from the raw, unfiltered `rows` array — which silently undid
BOTH the pre-existing hidden-profile filter and this PR's new bot exclusion
for any dance-filtered request. It now filters the already-hidden/excluded
`filtered` array.
TEST: services/gateway/test/routes/community-members.test.ts — "the dance filter does not resurrect hidden or excluded members"

## Not covered by this PR

- Admin-facing "all users" lists (`vitana-v1`'s admin Directory/Segments
  screens) — lower priority per the audit, admins already know about these
  accounts; not fixed here.
- `services/social-connect-repository.ts`, group-roster/"first 100" style
  automations in `community-groups.ts`/`sharing-growth.ts` — the audit
  flagged these as "not checked deeply", not confirmed either way. Left as
  an open follow-up rather than guessed at.
- The actual population mechanism for `daily_matches` (no INSERT into it
  was found anywhere in this repo) — outside this repo's own code, not
  investigated further.
