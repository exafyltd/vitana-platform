---
lane: reactions
state: ready
next_actor: kiro
depends_on: []
executor: kiro
seat: jtadic
area: messenger
reviewer_seat: agent:vitana-lane-reviewer
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
repos: [exafyltd/vitana-v1, exafyltd/vitana-platform]
paths:
  - supabase/migrations/20261117120000_message_reactions_full_emoji.sql
  - src/lib/reactions/**
  - src/hooks/useMessageReactions.ts
  - src/hooks/useMessageReactions.legacy-heart.test.ts
  - src/components/messages/MessageContextMenu.tsx
  - src/components/messages/MessageBubble.tsx
  - src/components/messages/MessageBubble.reaction-picker.test.tsx
  - src/components/ui/emoji-picker.tsx
  - src/components/ui/emoji-picker.composer-vs-reaction.test.tsx
  - src/i18n/*/chatNative.json
  - apps/mobile/src/screens/chat/EmojiPicker.tsx
  - apps/mobile/src/screens/chat/MessageBubble.tsx
  - apps/mobile/src/screens/chat/data/emojiRecents.ts
  - apps/mobile/src/screens/chat/data/reaction-emojis.json
  - apps/mobile/src/screens/chat/data/reactionEmoji.ts
  - apps/mobile/src/screens/chat/data/useReactions.ts
  - apps/mobile/tests/inbox-chat/conversation-chat/**
  - services/gateway/src/services/orb-tools/messaging-depth-tools.ts
  - services/gateway/src/services/orb-tools/reaction-emoji.ts
  - services/gateway/src/services/orb-tools/reaction-emojis.json
  - services/gateway/test/orb/reaction-emoji-full-set.test.ts
  - services/gateway/test/orb/latency/__snapshots__/vtid-04542-voice-payload-identity.test.ts.snap
  - services/gateway/test/orb/latency/vtid-04542-voice-payload-identity.hashes.json
  - services/gateway/test/orb/live/characterization/__snapshots__/system-instruction.characterization.test.ts.snap
  - services/gateway/test/orb/live/characterization/__snapshots__/tool-catalog.characterization.test.ts.snap
  - services/gateway/test/orb/reaction-expanded-gate.test.ts
  - services/gateway/test/orb/reaction-emoji-full-set.test.ts
  - src/hooks/useMessageReactions.gate.test.ts
  - apps/mobile/tests/inbox-chat/conversation-chat/reactions-expanded-gate.test.tsx
  - DATABASE_SCHEMA.md
  - docs/validation/**
updated: 2026-11-19T14:30Z
---
# Lane: reactions (repos vitana-v1 and vitana-platform)
Tasks in `tasks.md`. Continues vitana-v1 PR #1697 and vitana-platform PR #5105; both PRs carry this lane's one VTID.
VTID from PLAN-SPAR; never by hand.

## Log
### 2026-11-18T10:30Z · kiro-exafyltd-202611181004-a185 · created (ready)
Lane created with the plan.
### 2026-11-18T12:00Z · kiro-exafyltd-202611181004-a185 · ready
Replacement lane branches built on main bbe90b713. Expanded writes gated off on web, mobile and the gateway tool; rollback preserves member reactions.
### 2026-11-18T15:30Z · kiro-exafyltd-202611181004-a185 · ready
Lane heads: vitana-v1 cb7ddc6da, vitana-platform b870a49514 (rebased on main 349540a7a3). All emoji paths use Supabase VITANA at release; Aurora staging is a later cutover follow-up.
### 2026-11-19T12:30Z · kiro-exafyltd-202611181004-a185 · ready
Final lane heads: vitana-v1 a826e609ea, vitana-platform 7b8729e0d7. Reviewer agent (claude-sonnet-5.5): accept on both heads (advisory until a PR/MR head exists; the land step regenerates the review entry with a reviewer session id). Publication waits for a session with GitLab access (Kiro 1); VTID waits for D2.
### 2026-11-19T14:30Z · kiro-jtadic-202611191357-f5ff · ready (attribution corrected)
Owner instruction 2026-11-19: Kiro 12 attribution for current work. This Kiro Web account is Kiro 12 (seat `jtadic`,
docs/programs/areas.yaml); session kiro-exafyltd-202611181004-a185 was the same account under the wrong seat label. Seat set to
`jtadic`; the unpublished lane commits were rebuilt with `Collab-Session: kiro-jtadic-202611191357-f5ff` and author Kiro 12, content (trees) unchanged; the
historical `Claude-Session:` trailers stay. New in this head: the composer keeps its recents and seed; only the reaction "+"
filters to the 181-emoji set. Lane heads: vitana-v1 8778404bd7, vitana-platform 972017fa73.
