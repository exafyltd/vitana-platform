# Responses to sparring round 3 (session 1, escalated) — messenger-ux-v2
Session 1 escalated at the round cap, so this is a record only. Both findings are fixed in the re-planned `plan.md`,
which PLAN-SPAR spars as session 2.

```json
[
  {"finding_id": "R3-F1", "disposition": "accepted", "rationale": "I4 now states that a viewing-suppressed row is written exactly like the coalesced branch (notification-service.ts:870-899), with push_sent_at set at INSERT, no push, and push_outcome 'suppressed_viewing'. /push-dispatch therefore never re-selects it after the presence expires. Acceptance test: the row is suppressed while viewing, then the presence expires and /push-dispatch runs, and still no push goes out."},
  {"finding_id": "R3-F2", "disposition": "accepted", "rationale": "Instead of adding one more call site, the check moved to the two places every chat push passes: notifyUser and /push-dispatch, through services/chat-viewing-presence.ts. The conversation key comes from the payload: data.conversation_key, else group_id, else sender_id, else a message_id lookup. That covers the new-member-greeting branch (new-member-greeting-push.ts), calendar invites, the welcome refanout, and the ORB tool and welcome-team senders, with no caller edited. Acceptance has one test per such caller; the coalescer and chat-groups.ts are no longer edited."}
]
```
