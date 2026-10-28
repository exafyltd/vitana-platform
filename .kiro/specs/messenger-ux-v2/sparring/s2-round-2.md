# Sparring round 2 — converged

Session: `523b58d3-8841-478b-921e-d7b575396eec` · plan hash `441354756fd5e83c1575870cbc74b3bf6ac41f1c0f9738afbe103edd21f9fb19`

## Summary

Round 2: all seven round-1 findings were ACCEPTED (none rejected/deferred), and each acceptance's rationale in the revised plan is sound as written, so I acknowledge all seven. Two residual risks from the accepted fixes remain on record but could NOT be evidenced this round: (1) R1-F4's order-independent dedup runs 'before sending anything' and marks duplicates `suppressed_duplicate` relative to a kept/sent sibling — but on the NEW viewing path a kept row is marked `suppressed_viewing` (markHandled writes the suppress outcome, not push_sent_at), so a duplicate row can escape dedup and push after the 45s heartbeat lapses; dedup should be resolved on (user_id, message_id) BEFORE the viewing decision and all-but-one marked suppressed_duplicate even when the kept row is viewing-suppressed. (2) R1-F1's message_id fallback lookup in `chatConversationKeyFromData` assumes the vitana-v1 second-writer/trigger row's `data.message_id` equals chat_messages.id and carries sender_id; the plan itself records trigger body drift, so an unresolvable trigger row silently bypasses suppression — the duplicate (a) rule should be the backstop for that path. TOOLING NOTE: every read_file/list_dir against exafyltd/vitana-platform returned HTTP 403 and vitana-v1 reported 'no pinned ref' this round, so I could not re-read files to attach fresh read_file evidence; I therefore submit no new evidenced findings and no premise checks rather than fabricate citations.

## Findings

_none_
## Acknowledgements of earlier responses

- R1-F1: acknowledged — Revision now defines the recipient-perspective DM key (dm:<S>) and derives group_id -> sender_id -> message_id with conversation_key only as a logged cross-check, plus key-matrix tests. Sound.
- R1-F2: acknowledged — Per-caller Jest matrix enumerated (including listing_interest never suppressed) and notifyUser does the presence read itself. Sound.
- R1-F3: acknowledged — Server-side read-side batched conversation-membership check with null on foreign reply_to added in I1. Sound.
- R1-F4: acknowledged — Dedup made order-independent within a batch via (user_id, message_id) grouping and a both-NULL same-batch test added. Sound, subject to the residual viewing-path gap noted in the summary.
- R1-F5: acknowledged — Calendar-invite suppression retained but explicitly flagged at Gate 2 as a deliberate R13-grounded change with tests. Sound.
- R1-F6: acknowledged — Realtime basis cited (SELECT policy authorises UPDATE events; users_read_own_messages admits sender_id=auth.uid()) and CI coverage replaces a forbidden staging write. Sound.
- R1-F7: acknowledged — shared_content added to both allowedTypes sets and chat.ts sequenced 1->2->3->4; no action needed. Sound.
