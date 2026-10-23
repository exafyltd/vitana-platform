# VTID-05311 — shared posts, events, products and profiles in chats

VALIDATION_PROFILE: gateway_backend

ROUTE_MOUNT: `GET /api/v1/chat/shared-preview` — `routes/chat.ts` (existing `/api/v1/chat` mount). `POST /api/v1/chat/send` and `POST /api/v1/chat/groups/:id/send` accept `message_type: 'shared_content'`.

FINAL_URL: https://preview-aws-gateway.vitanaland.com/api/v1/chat/shared-preview (staging; only an unsigned rejected probe is sent)

CURL_PROOF: staging answers 401 to an unsigned `GET /api/v1/chat/shared-preview?kind=post&id=<uuid>`; resolving and sending are proven in CI.

OASIS_PROOF: n/a — no governed state change.

## Acceptance criteria

AC-1: A deleted item → `{available:false, reason:'deleted'}`.
  TEST: services/gateway/test/vtid-05311-chat-shared-content.test.ts ("a deleted item")
AC-2: An item the caller cannot read under RLS → `restricted`, even if the sender could; a post a moderator hid/removed → `restricted`; a delisted product → `deleted`; an unreadable profile is always `restricted` (no existence oracle on user ids); the preview is resolved with the caller's user-scoped client and the service-role client only checks existence (key column).
  TEST: services/gateway/test/vtid-05311-chat-shared-content.test.ts ("cannot read under RLS", "never reads item content")
AC-3: Profiles of `service_bot_accounts` / `notification_test_actors`, and posts / events they created → `restricted`; they cannot be shared.
  TEST: services/gateway/test/vtid-05311-chat-shared-content.test.ts ("service / test account", "cannot be shared")
AC-4: The stored message metadata holds the item only as `{kind, id}` (plus the server's own `reply_to` / a group's sanitized `mentions`); the sender must see the item, else 403 `share_not_allowed`; in groups the check runs after membership and the retry lookup; a caption ≤ 1000 chars.
  TEST: services/gateway/test/vtid-05311-chat-shared-content.test.ts ("sending a shared item")
AC-5: The push body is the catalog line `notif.chat_shared_content.body` in the recipient's language, never the item's content; not coalesced.
  TEST: services/gateway/test/vtid-05311-chat-shared-content.test.ts ("pushes a catalog line", "in their language")
