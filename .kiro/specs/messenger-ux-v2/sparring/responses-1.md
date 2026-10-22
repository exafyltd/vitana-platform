# Responses to sparring round 1 — messenger-ux-v2

```json
[
  {"finding_id": "R1-F2", "disposition": "accepted", "rationale": "I7 now names the swap sites. The id-based optimistic-to-real swap at useGlobalMessages.ts:1284-1286 and the group swap in GroupChat.tsx handleSend are replaced by one reconcileByClientId(rows, realRow). It matches on temp-<client_message_id> or on client_message_id, so a real row with any server id (gateway or fallback insert) replaces the optimistic bubble. The fallback insert already carries client_message_id (I7). New acceptance test: a real row whose id differs from the optimistic id leaves no stale 'sending' bubble."},
  {"finding_id": "R1-F3", "disposition": "accepted", "rationale": "I7 now says /chat/delivered is posted only for DM rows (receiver_id = me); group threads never call it. New acceptance test: a group message makes no /chat/delivered call."},
  {"finding_id": "R1-F4", "disposition": "accepted", "rationale": "chat_viewing_presence gains tenant_id (= identity.tenant_id) in I4 and in the lane's migration task. Rows are then tenant-scoped for cleanup, and the check matches the push's tenant."}
]
```
Also changed in this push, prompted by CI evidence and not by a finding: new lane `test-fixture-05201`, which lands
first. `main`'s `Vitest (jsdom)` is red on `ConversationView.deeplink-scroll.vtid-05201.test.tsx` (on origin/main
69d39ef34 and on #1472); the cause is a hard-coded fixture date plus an incomplete `i18n-toast` mock. The lane fixes
the fixture only, with assertions unchanged, so every later lane lands on a green suite. This moves the fix out of
`ui-scroll-anchoring`.
