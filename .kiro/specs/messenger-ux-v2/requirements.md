# Requirements — messenger-ux-v2
Source: the owner's spec "Vitanaland Messenger — UX Improvements & Functional Requirements", given to Kiro session
`kiro-exafyltd-202610211130-c65e` on 2026-10-21. Objective, quoted: *"Improve the Vitanaland Messenger experience to
deliver a modern, fast, compact, and reliable messaging experience comparable to Slack, WhatsApp, and Telegram, while
maintaining the Maxina/Vitanaland design system."* The owner asked for this order: *"inspect the current
implementation … propose the smallest coherent implementation plan. Then implement, test, and report"*.

| # | Requirement (owner's title) | Priority | Delivered by |
|---|---|---|---|
| R1 | Compact chat layout | P1 | #1425 (density, external) + lane `ui-compact-grouping` (grouping, avatars, timestamps) |
| R2 | Modern messaging interface | P1 | `ui-compact-grouping`, `ui-scroll-anchoring` (pill, divider), `ui-send-status` (status icons) |
| R3 | Reply to specific messages | P0 | `api-send-reliability` (persist, validate), `ui-reply-jump` (DM + group, jump to unloaded parent) |
| R4 | Send messages with Enter | P0 | #1445 (`messenger-paste-enter/composer`, external) + idempotent send (`api-send-reliability`, `ui-send-status`) |
| R5 | Direct screenshot pasting | P1 | #1445 (external); the file picker remains the fallback |
| R6 | Correct recent emoji history | P1 | #1424 (done) + `ui-emoji-recents` (per user, reactions included) |
| R7 | Real-time message status and retry | P0 | `api-send-reliability` (client id, delivered_at) + `ui-send-status` |
| R8 | Correct conversation opening and scroll position | P0 | `ui-scroll-anchoring` (first-frame acceptance), deep links kept (#1423) |
| R9 | New messages without forced scrolling | P0 | `ui-scroll-anchoring` |
| R10 | Improved media and file sharing | P1 | `ui-media-album` |
| R11 | Share community content directly in messages | P2 | `api-shared-content` + `ui-shared-cards` |
| R12 | Search across conversations and within chats | P2 | `api-message-search` + `ui-message-search` (uses `ui-reply-jump`'s jump) |
| R13 | Suppress push notifications for active open chats | P1 | `api-viewing-presence` + `ui-viewing-presence` |

Quality requirements carried into every lane: reuse the existing components, tokens, APIs, realtime and auth; backward
compatible with existing messages (all new columns nullable, new metadata keys optional); correct under slow
networks, reconnects, concurrent messages and upload failures; authorization on search, shared content, attachments
and delivery information; mobile + desktop, keyboard, touch and clipboard; automated tests for new behaviour plus the
existing Messenger regression suites.

Acceptance criterion R8, verbatim: *"Opening a conversation must display the newest message on the first visible
frame, without an observable scroll-to-bottom animation or jump."*
