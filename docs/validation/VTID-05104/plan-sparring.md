# Plan — Calendar invites, Phase 1: close the live gaps in the existing messenger invite flow

Change class: **standard** (touches gateway routes). Repo: exafyltd/vitana-platform (gateway only; no vitana-v1 change, no migration, no new table).
Background: owner approved the design `docs/design/VTID-04998-calendar-invites.md` (PR #4054) with all ten recommendations, including decision 10(b): "invite-flow fixes and guards first, as their own quick VTID, then full shared events behind a flag". This plan is only that first step.

<!-- plan:begin -->
## Problem (verified by reading code on origin/main)
Member-to-member calendar invites already exist (VTID-04917: `services/gateway/src/services/calendar-invite.ts`, `routes/calendar.ts` `/invites/:messageId/respond`, `GET /invites/:messageId`, `/events/:id/invite-preview`; chat message type `calendar_invite` accepted by `routes/chat.ts` `/send` and `routes/chat-groups.ts`). Four live gaps:
1. **Voice invites cannot be answered and can name a private/past entry.** `tool_send_calendar_invite_in_chat` (`services/orb-tools/messaging-depth-tools.ts` ~812-826) inserts its own metadata (`source:'voice', kind, event_id, title, ...`) with no `v:2`/`ref_type`; `inviteMetadataOf` (`calendar-invite.ts` ~176-186) rejects it, so respond/GET return 404. It also skips `buildInviteFromEntry`, which is where the "own, one-off, manual/invite, not past, not private" rules live.
2. **The app chat send route has no guard for invites:** `routes/chat.ts` `/send` checks only auth, tenant and "not yourself". Any tenant member can send a calendar-invite card (and the push that goes with it) to any other member. No test/service-account exclusion (CLAUDE.md Part 1 rules 43-45), no relationship check, no rate limit.
3. **Group invites are uncapped:** one message to a group of any size.
4. **Invite push bodies carry event details** (title etc.) onto the lock screen; owner decision 5 = generic text.

## What changes (gateway only)
A. New pure+IO module `services/gateway/src/services/calendar-invite-guard.ts` exposing one function `checkInviteSend({ senderId, receiverId | groupId, tenantId })` returning `{ ok:true } | { ok:false, code }` with a single outward-facing error shape so unknown/blocked/not-allowed recipients are indistinguishable (no member enumeration). Rules, in order:
   1. Sender and receiver are not in `service_bot_accounts` or `notification_test_actors` (both directions; Part 1 rules 43-45) — refused in code, not only by the notification sink guard. Uses the **strict, fail-closed** lookup (`fetchExcludedTestServiceAccountIdsStrict`, `excluded-test-service-accounts.ts`), not the fail-open read-surface variant. **Every check in this function fails closed:** a database error on the allowlist, relationship or quota lookup refuses the invite with the same generic error and logs the cause server-side.
   2. Same tenant.
   3. Relationship (owner decision 1b): allowed only if at least one holds: (a) a prior non-invite direct message exists between the two in either direction, (b) they are active co-members of a chat group, (c) a follow relation exists in either direction in `user_follows` (`follower_id`, `following_id`; already read by the gateway in `services/orb-tools/p0-gap-tools-repository.ts`). (a) reads `chat_messages` and (b) reads `chat_group_members`; the PR cites each query.
   4. Quotas (owner decision 6a, env-adjustable): at most 30 invites per sender per rolling 24h and at most 5 invites per sender→recipient pair per rolling 7 days, counted from existing `chat_messages` rows with `message_type='calendar_invite'` (no new table, **no migration, no new index**). The query always carries `tenant_id` and `sender_id` and a bounded `created_at` window so it uses the existing `(tenant_id, sender_id, created_at DESC)` index; the `message_type` and `receiver_id` filters are applied inside that sender-bounded range, which is small (one member's own messages in at most 7 days). Only the return shape (`{ allowed, reason, remaining }`) is borrowed from `checkVoiceSendQuota` (`voice-message-guard.ts`); its in-memory per-key counter is a different mechanism and stays as is for voice (see C). Constants overridable by env (`CALENDAR_INVITE_MAX_PER_DAY`, `CALENDAR_INVITE_MAX_PER_PAIR_WEEK`).
   5. Group invites: allowed only to a group the sender is an active member of and whose membership is at most 20 (decision 6a "20 invitees per event"; membership = the number of `chat_group_members` rows for the group, the schema has no inactive state); counts as one against the daily quota. Bigger groups: refused with the same generic error.
B. `routes/chat.ts` `/send`: when `message_type === 'calendar_invite'` call `checkInviteSend` before insert; other message types unchanged. `routes/chat-groups.ts` group send: same for `calendar_invite`.
C. Voice tool: keep `resolveMyCalendarEvent` to find the entry by id/title, then re-fetch the full own row (`getOwnCalendarEvent(eventId, userId)`) and pass it to `buildInviteFromEntry` (v2 metadata, `ref_type`/`ref_id`, same validations); call the same `checkInviteSend`. The existing voice quota (`checkVoiceSendQuota` with its synthetic per-user key `${user_id}:send_calendar_invite_in_chat`) is kept exactly as is — it is deliberately per-user, so it is not "fixed" to the real ORB session id (that would let a reconnect bypass it). A voice invite for a private/past/recurring entry now fails with the same message the app path gives.
D. Invite push (voice tool push at `messaging-depth-tools.ts` ~830-843 AND the app/group send routes' push): body becomes the generic "{Name} invited you to an event" via the server catalog helper `tt()` (CLAUDE.md §13b), no title/time/place. A new key is added to `GatewayI18nKey` in `services/gateway/src/i18n/catalog.ts` with translations in all four locale objects (DE, EN, ES, SR). The in-app chat card content (title/time/place, shown inside the conversation) is unchanged; category stays as today (the dedicated `calendar_invite` category is Phase 4).
E. Docs: `DATABASE_SCHEMA.md` untouched (no schema change). Add `docs/validation/<VTID>/` pack. Update the design doc status line ("Phase 1 shipped").

## Not in this plan (deferred, tracked in the design doc)
A tenant check on the receiver for ALL direct messages: `routes/chat.ts` `/send` validates the sender's tenant (`requireTenant`) but not the receiver's for any message type. This plan adds the same-tenant rule for `calendar_invite` only; the broader gap is pre-existing, is reported to the owner in Gate 1, and would be its own VTID. Shared-event tables and copies, organizer edit/cancel propagation, attendee list, invitee-side mute (decision 2b), `member_blocks`, the RLS fix on `calendar_invite_responses` (a migration; ships with Phase 2), frontend changes, flag/per-tenant rollout, the dedicated notification category.

## Tests (Jest, in-memory, no network, no database)
- Pure unit tests for each rule of `checkInviteSend` including: test account as sender and as receiver, other-tenant receiver, no relationship, each of (a)(b)(c), 31st invite in a day, 6th in a pair-week, group of 21, same generic error for every refusal, no leakage of which rule failed.
- Route contract tests for `/chat/send` and the group send with `calendar_invite`: refused cases answer the generic error and insert nothing; allowed case inserts; non-invite messages unaffected (existing chat tests stay green).
- Voice tool: a v2 invite is stored and `inviteMetadataOf` accepts it; private/past/recurring entry refused; push body contains no title.
- Mutation checks (two): removing the test-account check and removing the quota check each fail the suite.
- Existing suites must stay green: calendar suites (`npm run test:calendar`), `test:support` if touched, `tsc --noEmit`.
- Staging: read-only by rule; this change is proven by Jest only. STAGING-VERIFY smoke + this change's `staging-tests.json` (the Jest suite).

## Rollout / risk
No flag: these are guards and a bug fix on an existing path. Risk: legitimate first-time invites between members with no relationship now fail; mitigated by the relationship definition including shared groups and any prior DM, and by one generic, translated error. Quotas are env-adjustable without a deploy of code. No production writes outside the normal deploy; Gate 2 applies (gateway deploy).

## Files in scope
`services/gateway/src/services/calendar-invite-guard.ts` (new), `services/gateway/src/routes/chat.ts`, `services/gateway/src/routes/chat-groups.ts`, `services/gateway/src/services/orb-tools/messaging-depth-tools.ts`, `services/gateway/src/i18n/catalog.ts`, `services/gateway/src/services/calendar-invite.ts` (only if a small export is needed), `services/gateway/test/vtid-<new>-calendar-invite-guard.test.ts` (new), `docs/design/VTID-04998-calendar-invites.md` (status line), `docs/validation/<VTID>/**`.
<!-- plan:end -->

## Planner responses (round 1)

- **F1 [major] quota query has no supporting index — ACCEPTED, resolved without a migration.** The existing index `(tenant_id, sender_id, created_at DESC)` serves the query when it carries `tenant_id`, `sender_id` and a bounded window; `message_type` and `receiver_id` are filtered inside that sender-bounded range (one member's own messages over at most 7 days, small). The plan now says so, keeps "no migration, no new index", and drops the false claim of reusing the voice guard's counter (only its return shape is borrowed). Answer to question 1: the no-migration constraint stays; the in-memory alternative is rejected because it resets on deploy and scale-out.
- **F2 [major] receiver tenant is not checked for any DM — ACCEPTED (documented, not widened).** Added to "Not in this plan": the same-tenant rule is added for `calendar_invite` only; the broader pre-existing gap is its own VTID and is reported to the owner in Gate 1.
- **F3 [major] fail-open vs fail-closed — ACCEPTED.** `checkInviteSend` uses `fetchExcludedTestServiceAccountIdsStrict` and every lookup (allowlist, relationship, quota) fails closed with the same generic error, cause logged server-side. Answer to question 2: strict variant.
- **F4 [minor] voice push also leaks details and is hardcoded English — ACCEPTED.** Section D now covers the voice tool push (~830-843) and the app/group routes' push; the in-app chat card content is unchanged.
- **F5 [minor] voice quota key is per-user, not per-session — ACCEPTED.** Plan states it is kept exactly as is and must not be "fixed" to the real session id.
- **F6 [minor] missing catalog key and file — ACCEPTED.** `services/gateway/src/i18n/catalog.ts` added to files in scope; new `GatewayI18nKey` with DE, EN, ES, SR translations.
- **F7 [minor] "active" membership undefined — ACCEPTED.** Membership = count of `chat_group_members` rows for the group (no inactive state in the schema).
- **Question 3 (replace or layer):** layer. `resolveMyCalendarEvent` still finds the entry by id/title; the full own row is then re-fetched with `getOwnCalendarEvent(eventId, userId)` and passed to `buildInviteFromEntry`.

---

Verdict: converged after 2 rounds (partner: plan-sparring-partner). Owner approval: "Yes" in chat at Gate 1, 2026-10-12. Plan hash (sha256 of the text between the plan markers): 7ac875be4a1ed09f26983b588ad91c0794670ff23dfcf24f6dd640ad40059e31
