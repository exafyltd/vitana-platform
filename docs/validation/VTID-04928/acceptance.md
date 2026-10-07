# VTID-04928 — Group-message pushes open the received message (gateway half)

AC-1 The generic group push (`new_chat_message`, type `new_group_message`) sent from POST /chat/groups/:id/send deep-links to `/inbox/g/<groupId>/msg/<messageId>`; the mention push keeps its own deep link and nobody gets two pushes.
TEST: services/gateway/test/vtid-04926-chat-group-mentions.test.ts — "stores only the sanitized tags and pushes chat_mention to the tagged member" (asserts the generic push url)

AC-2 Every group-message push site — send fanout and welcome re-fanout in `routes/chat-groups.ts`, ORB voice send in `services/orb-tools/messaging-depth-tools.ts` — links to `/inbox/g/<groupId>/msg/<messageId>`, never to the bare group.
TEST: services/gateway/test/vtid-04928-group-push-opens-message.test.ts

AC-3 ORB navigation to a group conversation is unchanged (`/inbox/g/<chat_group_id>`).
TEST: services/gateway/test/orb-tools/inbox-conversation-nav.test.ts

ROUTE_MOUNT: no new route. Only the push payload `url` inside existing handlers changes in `services/gateway/src/routes/chat-groups.ts`; router mounted at `/api/v1/chat/groups` (services/gateway/src/index.ts).
FINAL_URL: `POST /api/v1/chat/groups/:id/send` (unchanged path); app deep link `/inbox/g/:groupId/msg/:messageId` (existing route in exafyltd/vitana-v1 App.tsx).
CURL_PROOF: read-only staging probe in staging-tests.json — unauthenticated `GET /api/v1/chat/groups/<uuid>` → `401 application/json`. Landing on the message in the app is verified by the community-app staging suite (exafyltd/vitana-v1 docs/validation/VTID-04928).

OASIS_IMPACT: no — no new state transition or event type; only the notification deep-link string changes.
