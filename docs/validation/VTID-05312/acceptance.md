# VTID-05312 — no chat push for the conversation the recipient is viewing

VALIDATION_PROFILE: gateway_backend

ROUTE_MOUNT: `POST /api/v1/chat/viewing` — `routes/chat-viewing.ts`, mounted by `routes/chat.ts` (`router.use('/viewing', …)`) under the existing `/api/v1/chat` mount.

FINAL_URL: https://preview-aws-gateway.vitanaland.com/api/v1/chat/viewing (staging; only an unsigned rejected probe is sent)

CURL_PROOF: staging answers 401 to an unsigned `POST /api/v1/chat/viewing`; every write path is proven in CI only.

OASIS_PROOF: n/a — heartbeats are ephemeral (CLAUDE.md NEVER 10).

## Acceptance criteria

AC-1: DM A→B is suppressed when B views dm:<A>; B viewing dm:<C> or A's own presence never suppresses; expired rows don't count; any device counts; only a presence row of the push's tenant counts (a push without a tenant is never suppressed).
  TEST: services/gateway/test/vtid-05312-chat-viewing-presence.test.ts ("key = the recipient's view")
AC-2: notifyUser writes a viewing-suppressed row with push_sent_at at INSERT, outcome suppressed_viewing, no push — for every push caller's payload shape; in a group a viewing member gets no push (message and mention) while a non-viewing member does; the row is never picked up by /push-dispatch later (even after the presence expired); the email fallback never runs for suppressed_viewing / suppressed_duplicate; listing_interest never suppressed.
  TEST: services/gateway/test/vtid-05312-chat-viewing-presence.test.ts ("notifyUser (every caller, no caller edited)")
AC-3: /push-dispatch suppresses viewing rows and dedups (both orders, both unpushed in one batch); a batch of N rows needing the message lookup does exactly one chat_messages read and one presence read; the already-pushed sibling read is scoped to the batch's recipients.
  TEST: services/gateway/test/vtid-05312-chat-viewing-presence.test.ts ("/push-dispatch")
AC-4: POST /chat/viewing validates, upserts per (user, device) with 45 s expiry, deletes on active:false (only that conversation's row when a key is sent), sweeps expired rows; after active:false the next push goes out.
  TEST: services/gateway/test/vtid-05312-chat-viewing-presence.test.ts ("POST /chat/viewing")
Known limit (fails open, as plan I4 implies): a DM push carries the sender's tenant (chat.ts) and a presence row
the recipient's active tenant, so for members of two tenants a cross-tenant DM is pushed even while viewed.

AC-5: The push_outcome CHECK keeps every earlier value and adds suppressed_viewing and suppressed_duplicate.
  TEST: services/gateway/test/vtid-05312-chat-viewing-presence.test.ts ("migration")
