# Responses to sparring round 3 (session 1, escalated) — messenger-ux-v2
This session escalated at the round cap; both findings are fixed in the re-planned `plan.md` (session 2).

```json
[
  {"finding_id": "R3-F1", "disposition": "accepted", "rationale": "Chose option (b) deliberately and documented it in I4. The owner's R13 asks for no push for incoming messages while the recipient is viewing that conversation. A calendar invite sent into a viewed DM or group is a message of that conversation, its card appears live, and the in-app row is kept, so it is suppressed too. The I4 text names this as replacing, for the viewing case only, the coalescer's 'invites are never coalesced' rule (chat.ts:268); that rule stays unchanged for bursts. Types other than new_chat_message / chat_mention, such as listing_interest (chat.ts:228-236), are never suppressed. Tests: an invite is suppressed when the recipient is viewing and pushed when not; listing_interest is never suppressed."},
  {"finding_id": "R3-F2", "disposition": "accepted", "rationale": "The /push-dispatch bullet in I4 now says keys are resolved for the whole batch before the loop: one select on chat_messages where id = any($message_ids) for rows that need the message_id fallback, then one presence read for all (recipient, key) pairs, with no per-row query. Acceptance asserts the mock call counts."}
]
```
