# VTID-04926 — Group chat @mentions (gateway half)

AC-1 sanitizeMentions keeps only members of the group whose `@display_name` appears in the text; never the sender, the Vitana bot, a service/test account, a malformed id, an over-long name or a duplicate.
TEST: services/gateway/test/vtid-04926-chat-group-mentions.test.ts — "sanitizeMentions (VTID-04926)"

AC-2 POST /chat/groups/:id/send stores only the sanitized list in `metadata.mentions`, and no `mentions` key when nobody is validly tagged; other content_data (attachments) is kept unchanged.
TEST: services/gateway/test/vtid-04926-chat-group-mentions.test.ts — "stores only the sanitized tags…", "stores no mentions key…", "keeps other content_data…"

AC-3 A tagged member gets exactly one push, `chat_mention`, titled in their language and deep-linking to `/inbox/g/<group>/msg/<message>`; every other member still gets the unchanged `new_chat_message`.
TEST: services/gateway/test/vtid-04926-chat-group-mentions.test.ts — "stores only the sanitized tags and pushes chat_mention to the tagged member"

AC-4 If the service/test-account lookup fails, the message still sends and nobody is tagged (fail closed).
TEST: services/gateway/test/vtid-04926-chat-group-mentions.test.ts — "fails closed when the test-account lookup errors"

AC-5 GET /chat/groups/:id marks each member `mentionable` (false for the bot and service/test accounts; false for everyone if the lookup fails).
TEST: services/gateway/test/vtid-04926-chat-group-mentions.test.ts — "GET /:id mentionable flag (VTID-04926)"

AC-6 The new push text `notif.chat_mention.title` exists, translated with intact placeholders, in every shipped gateway locale; `chat_mention` / `comment_mention` are registered in the notification catalog.
TEST: services/gateway/test/i18n/catalog-coverage.test.ts, services/gateway/test/vtid-04674-notification-controls.test.ts

AC-7 Migration 20261006150000 switches `chat_mention` and `comment_mention` ON per tenant (an auto-registered OFF row is turned on, an admin's deliberate OFF is kept), maps them to the member categories, and is idempotent.
TEST: applied twice to a throwaway local Postgres 16 with stub tables — see outputs/local-checks.txt

ROUTE_MOUNT: no new route. Existing handlers changed in `services/gateway/src/routes/chat-groups.ts` (POST `/:id/send`, GET `/:id`), router mounted at `/api/v1/chat/groups` (services/gateway/src/index.ts).
FINAL_URL: `POST /api/v1/chat/groups/:id/send`, `GET /api/v1/chat/groups/:id` (unchanged paths).
CURL_PROOF: read-only staging probe in staging-tests.json — unauthenticated `GET /api/v1/chat/groups/<uuid>` → `401 application/json`. The signed-in `mentionable` check runs in the community-app staging suite (exafyltd/vitana-v1 docs/validation/VTID-04926).

OASIS_IMPACT: no — no new state transition or event type; the existing chat send path and its events are unchanged.
