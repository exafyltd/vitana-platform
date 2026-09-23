# VTID-04447 — Conversation API bound to the caller's verified identity

## Problem (found while tracing D12, 2026-09-23)
`POST /api/v1/conversation/turn` and `/stream` accepted `user_id` and `tenant_id`
from the request body and had no authentication. Those fields decide:
- whose memory `buildAssistantMemoryContext()` reads into the prompt;
- whose memory the turn writes (`writeMemoryItemWithIdentity`, inline fact extraction);
- whose role the `developer_assistant` channel checks.

So an unauthenticated caller who knew a member's user id could read that member's
memory back through the model, write facts into it, or pass the developer check by
naming a developer's id. `GET /history/:threadId` returned any thread's messages and
`GET /threads/active` any user's latest thread, also unauthenticated.

No caller of these routes was found in either repo (the Command Hub only reads
`/health`, `/tools`, `/tool-health`, which stay public).

## Acceptance criteria
- AC-1: a request with no verified identity is refused with 401. TEST: services/gateway/test/vtid-04447-conversation-identity.test.ts
- AC-2: a `user_id` that is not the caller is refused with 403 IDENTITY_MISMATCH, never silently replaced. TEST: services/gateway/test/vtid-04447-conversation-identity.test.ts
- AC-3: user and tenant default to the JWT when omitted. TEST: services/gateway/test/vtid-04447-conversation-identity.test.ts
- AC-4: another tenant is allowed only for a member; the check fails closed when the store is unavailable. TEST: services/gateway/test/vtid-04447-conversation-identity.test.ts
- AC-5: `/turn`, `/stream`, `/history/:threadId`, `/threads/active` all run `requireAuth`; only the catalog/health routes stay public. TEST: services/gateway/test/vtid-04447-conversation-identity.test.ts
- AC-6: history is filtered to the caller's own messages. TEST: services/gateway/test/vtid-04447-conversation-identity.test.ts

## Not verified live
No request was sent to staging or production (that would read real memory). The next
staging deploy's anonymous `POST /api/v1/conversation/turn` should return 401 JSON.
`test/live-verification-d1-d51.sh` calls `/turn` without a token and now needs one.
