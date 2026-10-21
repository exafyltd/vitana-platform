# VTID-05310 — idempotent chat sends, persisted replies, delivered_at, context window

Lane `messenger-ux-v2/api-send-reliability` (plan `.kiro/specs/messenger-ux-v2/plan.md` I1-I3, converged by CI PLAN-SPAR,
policy `converged-auto-v1`).

VALIDATION_PROFILE: gateway_backend

ROUTE_MOUNT: new `POST /api/v1/chat/delivered` on the existing chat router (`mountRouterSync(app, '/api/v1/chat', …)`);
`GET /api/v1/chat/conversation/:peerId` and `GET /api/v1/chat/groups/:id/messages` gain `?around=` / `?after=`.

FINAL_URL: https://preview-aws-gateway.vitanaland.com/api/v1/chat/delivered (staging; only unsigned rejected probes are sent)

CURL_PROOF: staging answers 401 to unsigned `POST /api/v1/chat/delivered` and `POST /api/v1/chat/send` (rejected probes);
every write path is proven in CI only (CLAUDE.md rule 48).

OASIS_PROOF: n/a — no OASIS event added or changed (delivery receipts are routine like /read).

## Acceptance criteria

AC-1: The same (sender, client_message_id) twice stores one row; the second answer is 200 `duplicate: true` with the stored row and no push.
  TEST: services/gateway/test/vtid-05310-chat-send-reliability.test.ts ("a repeat of the same client_message_id…")
AC-2: A lost race on the unique index (23505) answers as the duplicate, never 500.
  TEST: services/gateway/test/vtid-05310-chat-send-reliability.test.ts ("a lost race on the unique index…")
AC-3: Before the migration the send still succeeds (column missing → retried without it); /delivered answers updated 0.
  TEST: services/gateway/test/vtid-05310-chat-send-reliability.test.ts ("without the migration…", "answers updated: 0 before the migration")
AC-4: A reply target outside the DM pair / group, or unknown, is 400 invalid_reply_target; a valid one is stored as metadata.reply_to = { message_id } only.
  TEST: services/gateway/test/vtid-05310-chat-send-reliability.test.ts ("replies" block, "groups" block)
AC-5: Reads expose reply_to_message_id only for in-conversation targets (a forged one reads as null).
  TEST: services/gateway/test/vtid-05310-chat-send-reliability.test.ts ("reads expose reply_to_message_id only…")
AC-6: /delivered only touches rows the caller received; > 200 ids, an empty list or a malformed id is 400; /read also fills delivered_at.
  TEST: services/gateway/test/vtid-05310-chat-send-reliability.test.ts ("POST /chat/delivered and /chat/read" block)
AC-7: ?around= returns the window ascending with has_older/has_newer and 404s outside the conversation; ?after= pages forward; a non-uuid peer id is 400.
  TEST: services/gateway/test/vtid-05310-chat-send-reliability.test.ts ("GET ?around=" block)
AC-8: Requests without the new fields behave exactly as before.
  TEST: services/gateway/test/chat-vitana-reply.test.ts, services/gateway/test/vtid-04917-invite-routes.test.ts, services/gateway/test/vtid-04926-chat-group-mentions.test.ts
AC-9: A client_message_id reused for another conversation is 409 client_message_id_conflict; a retry of a sent invite gets the stored row before the invite limits run.
  TEST: services/gateway/test/vtid-05310-chat-send-reliability.test.ts ("review findings" block)
AC-10: A reply target in client content_data is dropped; a group duplicate answers with the stored reply target and never re-triggers the @vitana reply.
  TEST: services/gateway/test/vtid-05310-chat-send-reliability.test.ts ("review findings" block)
