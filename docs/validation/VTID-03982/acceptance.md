# VTID-03982 — hide dev/automation chat accounts from every user's inbox

## Report

A 2026-09-16 bootstrap step created two internal dev/automation service
accounts — `claude-code-agent@exafy.io`
(`887b34cb-9ee9-47dc-ad53-db5be1869846`) and `operator-autopilot@exafy.io`
(`856c30ed-7136-4bc5-8bfe-86a1e8ea1401`) — and each sent a "Hello! My name
is ..." intro DM to every community member. Confirmed via read-only query
against `chat_messages`: 222 distinct real users received a DM from
`claude-code-agent`, 223 from `operator-autopilot`, all inserted at the
exact account-creation timestamps (11:38:38 / 11:38:40 UTC that day). That
landed a dev-only chat thread in every affected user's inbox in the
`exafyltd/vitana-v1` MAXINA app — reported live via a screenshot showing
both accounts in the "Alle" (All) inbox tab.

## Acceptance Criteria

AC-1 — `GET /conversations` never returns either dev/automation account as
a peer, on either code path: the `get_recent_conversations` RPC
success path, and its client-side-dedup fallback (used when the RPC
errors).

TEST: `services/gateway/test/chat-dev-service-accounts.test.ts` —
"excludes dev accounts from the RPC (get_recent_conversations) path" and
"excludes dev accounts from the client-side-dedup fallback when the RPC is
unavailable".

AC-2 — `GET /unread-count` excludes messages sent by either dev/automation
account, so hiding their thread from the conversation list does not leave
a permanently unclearable unread badge for a conversation the user can no
longer open.

TEST: `services/gateway/test/chat-dev-service-accounts.test.ts` —
"excludes messages sent by dev accounts from the unread count".

## What could NOT be run locally

`npm ci` in `services/gateway` was runnable in this session (unlike some
prior VTIDs in this repo's history) — the full targeted test run and
`tsc --noEmit` were both executed locally and passed; see `commands.log`.

## Related change (companion PR, not part of this gateway diff)

`exafyltd/vitana-v1` PR #1097 hides the same two accounts on the frontend
(`src/hooks/useGlobalMessages.ts`'s `isRealPeer()`/`stripUnknownUserThreads()`),
covering the legacy `global_message_threads` path and the direct
`chat_messages` Supabase fallback the frontend also reads from — this
gateway change alone does not cover those two client-side-only paths.

OASIS_PROOF: not applicable — `OASIS_IMPACT: no`. This change adds no
`oasis_events` emission path; it only filters two already-narrow account
IDs out of two existing read responses.
