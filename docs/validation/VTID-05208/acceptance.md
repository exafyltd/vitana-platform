# VTID-05208 — grouped pushes for new-member greeting DMs

Plan: `plan-sparring.md` (copy of `.kiro/specs/new-member-welcome/plan-sparring.md`), plan block S4 + tasks D1–D2; lane
`new-member-welcome/grouped-welcome-notifications`. Owner approval at Gate 1 on 2026-10-15 (plan hash `f7cdefc3043249c5`;
owner D2 = b: the greeting is a private DM sent on explicit Send, tagged `metadata.source='new_member_greeting'`). Text in the
spec that says "comment" or "backing post" is superseded.

VALIDATION_PROFILE: gateway_backend

ROUTE_MOUNT: no new route; `POST /api/v1/chat/send` changed in push dispatch only. Mounts in services/gateway/src/index.ts unchanged.

FINAL_URL: https://preview-aws-gateway.vitanaland.com/api/v1/chat/send (staging; only an unsigned rejected probe is sent).

CURL_PROOF: staging answers 401 to an unsigned `POST /api/v1/chat/send` and `GET /api/v1/chat/unread-count` (router still
mounted). Every behaviour that needs a write is proven in CI only (CLAUDE.md rule 48).

OASIS_PROOF: n/a — no OASIS event added or changed (OASIS_IMPACT: no).

## Acceptance criteria

AC-1: The first greeting DM to a newcomer in 24 h pushes as before (sender name title, message preview), tagged
`chat:new_member_greeting`, with `data.greeting_group='new_member_greeting'` and `data.greeting_count`.
  TEST: services/gateway/test/vtid-05208-new-member-greeting-push.test.ts ("a) the first greeting pushes…")
AC-2: N greeting DMs from N senders within 24 h → N in-app rows (each with its own sender title), exactly one push; the other
N−1 rows are `push_outcome='coalesced'` and call neither FCM nor Appilix (D2 golden).
  TEST: services/gateway/test/vtid-05208-new-member-greeting-push.test.ts ("b) D2 golden…"); mutation-checked (inverting the
  push decision fails b, plus a, c, d, e and the 23 h/25 h case)
AC-3: A greeting push after the window, with greetings still inside it, reads "{count} people said hello 👋" with title
"Welcome to the community 👋" in the recipient's language (`tt()` + `getUserLocale`); `{count}` = distinct greeters.
  TEST: services/gateway/test/vtid-05208-new-member-greeting-push.test.ts ("c) …localized summary (DE and EN)", "e) the same sender twice counts once")
AC-4: The window is anchored on the last real greeting push and does not reset on read.
  TEST: services/gateway/test/vtid-05208-new-member-greeting-push.test.ts ("d) reading the greeting does not reset the window", "a greeting pushed 23 h ago still holds; one pushed 25 h ago does not", "the greeting read is one query…")
AC-5: Ordinary DMs are unchanged: an untagged DM (or another `source`) still goes through `coalesceChatPushes` keyed `dm:<sender>`.
  TEST: services/gateway/test/vtid-05208-greeting-send-route.test.ts; services/gateway/test/vtid-05137-chat-push-coalescing.test.ts; services/gateway/test/chat-vitana-reply.test.ts
AC-6: Test/service/automation accounts (CLAUDE.md rules 43–45) never receive or trigger a greeting notification: an excluded
sender or receiver, or a failed exclusion lookup (fail closed), means no in-app row and no push, also when grouping is off.
Enforced in `new-member-greeting-push.ts` (`fetchExcludedTestServiceAccountIdsStrict` over `service_bot_accounts ∪
notification_test_actors`); seatbelts: the DB sink guard `_notif_is_test_actor()` on `user_notifications` and lane C's send guard.
  TEST: services/gateway/test/vtid-05208-new-member-greeting-push.test.ts ("h) …" — 6 cases + "an excluded greeter writes no row"); services/gateway/test/vtid-05208-greeting-send-route.test.ts ("…prepare step returns null…")
AC-7: Grouping fails open: a greeting-window read error, or `NEW_MEMBER_GREETING_PUSH_GROUPING_ENABLED=false`, falls back to
exactly today's per-conversation coalescing.
  TEST: services/gateway/test/vtid-05208-new-member-greeting-push.test.ts ("f) …", "g) …")
AC-8: Both catalog keys `notif.new_member_greeting_burst.title` / `.body` exist in all 11 shipped locales (de en es sr fr pt ru
pl zh ar tr), non-empty, not English, `{count}` preserved, DE du-form.
  TEST: services/gateway/test/vtid-05208-new-member-greeting-push.test.ts ("k) …"); services/gateway/test/i18n/catalog-coverage.test.ts
AC-9: STAGING-VERIFY green on the merge commit.
  TEST: docs/validation/VTID-05208/staging-tests.json

## Decisions taken

- Recipient-keyed 24 h window anchored on the last greeting push that really went out, independent of read state (S4 wording).
- Greeting rows are stamped `data.greeting_group` / `data.greeting_count`; the read uses the existing
  `idx_user_notifications_chat_conv` (leading `user_id`) — **no migration in this lane**.
- Push shape: count 1 → unchanged payload; count > 1 → catalog title/body; held-back rows keep their own sender title and preview.
  Deep link stays `/inbox/u/<sender>`.
- Test/service-account exclusion is fail-closed and not bypassed by the off switch.
- Arabic: real Arabic text for the two new keys and the `AR_TRANSLATED` allowlist in `catalog-coverage.test.ts` extended
  (VTID-05095 pattern). This adds coverage; it does not loosen any assertion (`weakens_tests: []`).
- New env var `NEW_MEMBER_GREETING_PUSH_GROUPING_ENABLED` (default on); no other default changes.
- The route-level tests live in their own file (`vtid-05208-greeting-send-route.test.ts`) because they mock
  `notification-service`, which the golden simulation runs for real.
