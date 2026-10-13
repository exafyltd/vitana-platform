# VTID-05137 — WhatsApp-style chat pushes: one push per conversation per burst

Owner report 2026-10-12 (screenshots: three "Dragan Alexander" cards in the Android tray). Plan: `plan-sparring.md` (standard class, rounds 1–2 CONVERGED, owner-approved at Gate 1 on 2026-10-13). This PR is the gateway half; the web service-worker tag is in `exafyltd/vitana-v1` (same plan, together with VTID-05138).

VALIDATION_PROFILE: gateway_backend

ROUTE_MOUNT: no new route. Existing routes changed in behaviour only: `POST /api/v1/chat/send` and `POST /api/v1/chat-groups/:id/send` (push dispatch), `POST /api/v1/chat-groups/:id/read` (also clears the member's group chat notifications). Mounts in services/gateway/src/index.ts unchanged.

FINAL_URL: https://preview-aws-gateway.vitanaland.com/api/v1/chat/send (staging; only an unsigned rejected probe is sent).

CURL_PROOF: staging answers 401 to an unsigned `POST /api/v1/chat/send` (route still mounted after the change). Every behaviour that needs a write is proven in CI only (CLAUDE.md rule 48).

OASIS_PROOF: n/a — no OASIS event added or changed (OASIS_IMPACT: no).

## Acceptance criteria

AC-1: The first chat message in a conversation pushes exactly as before, and the payload now carries `tag` and `data.conversation_key`/`data.tag` = `chat:<key>`.
  TEST: services/gateway/test/vtid-05137-chat-push-coalescing.test.ts ("every payload carries the conversation key and tag")
AC-2: A further message within 5 minutes, while the pushed one is unread, writes the in-app row (`push_sent_at` set, `data.push_coalesced='true'`), calls neither FCM nor Appilix, and records `push_outcome='coalesced'`.
  TEST: services/gateway/test/vtid-05137-chat-push-coalescing.test.ts ("a burst inside the window is held back", "writes the in-app row, marks it handled, sends nothing, records coalesced")
AC-3: Held-back or suppressed rows never anchor the window; after the recipient reads the conversation the next message pushes at once.
  TEST: services/gateway/test/vtid-05137-chat-push-coalescing.test.ts ("held-back rows do not count as pushed", "a row whose push was suppressed (DND)…", "first message (nothing unread) pushes")
AC-4: After the window the next push reads "{count} new messages · {preview}" in the member's language (`notif.chat_burst.body` in de, en, es, fr, pl, pt, ru, sr, tr, zh; ar falls back to EN like every key — catalog-coverage rule).
  TEST: services/gateway/test/vtid-05137-chat-push-coalescing.test.ts ("after the window the push summarises the unread messages, in the member's language")
AC-5: Mentions always push; calendar invites and listing-interest pushes are never coalesced.
  TEST: services/gateway/test/vtid-05137-chat-push-coalescing.test.ts ("a mention always pushes"); services/gateway/test/vtid-05104-calendar-invite-guard.test.ts; services/gateway/test/vtid-04926-chat-group-mentions.test.ts
AC-6: One batched read per message for all recipients; a read error fails open; `CHAT_PUSH_COALESCING_ENABLED=false` restores the old behaviour.
  TEST: services/gateway/test/vtid-05137-chat-push-coalescing.test.ts ("one batched read…", "a read error fails open", "CHAT_PUSH_COALESCING_ENABLED=false…")
AC-7: FCM/web push carries `chat:<key>` as Android tag, APNs collapse id and webpush tag.
  TEST: services/gateway/test/vtid-05137-chat-push-coalescing.test.ts ("FCM/web push carries the chat tag so the card is replaced")
AC-8: Opening a group clears only that member's unread chat notifications for that group.
  TEST: services/gateway/test/routes/chat-groups-repository.test.ts ("markGroupChatNotificationsRead (VTID-05137)")
AC-9: Migration applied before merge (CHECK gains `coalesced`, validated; index `idx_user_notifications_chat_conv`).
  CURL: RUN-MIGRATION https://github.com/exafyltd/vitana-platform/actions/runs/38375845593 + read-only check in outputs/README.md
AC-10: STAGING-VERIFY green on the merge commit.
  TEST: docs/validation/VTID-05137/staging-tests.json

Known limit (stated to the owner at Gate 1): the native apps receive pushes through Appilix, which cannot replace or stack a card; on phones this change means one card per conversation per burst, not several message lines inside one card.
