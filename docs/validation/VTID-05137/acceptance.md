# VTID-05137 — acceptance

Owner report 2026-10-12: chat pushes from one sender stack as separate cards. Plan: `plan-sparring.md` (converged, owner-approved Gate 1).

| AC | Criterion | Evidence |
|----|-----------|----------|
| AC-1 | First chat message in a conversation pushes exactly as before, plus `tag`/`data.conversation_key` | `vtid-05137-chat-push-coalescing.test.ts` "every payload carries the conversation key and tag" |
| AC-2 | A further message within 5 min while the pushed one is unread writes the in-app row (push_sent_at set, `data.push_coalesced`), calls neither FCM nor Appilix, records `push_outcome='coalesced'` | "a burst inside the window is held back", "writes the in-app row, marks it handled, sends nothing" |
| AC-3 | After the recipient reads the conversation, the next message pushes at once | rows are read with `read_at IS NULL`; "first message (nothing unread) pushes" |
| AC-4 | After 5 min the next push says "{count} new messages · {preview}" in the member's language (11 gateway locales) | "after the window the push summarises the unread messages" |
| AC-5 | @mentions, calendar invites and listing-interest pushes always push | "a mention always pushes"; `chat.ts` / `chat-groups.ts` gate on type |
| AC-6 | One read per message for a whole group (batched), fail-open on error, off switch `CHAT_PUSH_COALESCING_ENABLED=false` | "one batched read…", "a read error fails open", "…=false pushes every message" |
| AC-7 | FCM/web push carries `chat:<key>` as Android tag, APNs collapse id and webpush tag | "FCM/web push carries the chat tag" |
| AC-8 | Migration applied before merge (CHECK gains `coalesced`, index `idx_user_notifications_chat_conv`) | RUN-MIGRATION run link in the PR |
| AC-9 | STAGING-VERIFY green on the merge commit | `staging-tests.json` |

Known limit (stated to the owner at Gate 1): the native apps receive pushes through Appilix, which cannot replace or stack a card; on phones this change means one card per conversation per burst, not several message lines inside one card.
