---
lane: reactions
state: ready
next_actor: kiro
depends_on: []
executor: kiro
seat: exafyltd
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
updated: 2026-11-18T12:00Z
---
# Lane: reactions (repos vitana-v1 and vitana-platform)
Tasks in `tasks.md`. Continues vitana-v1 PR #1697 and vitana-platform PR #5105; both PRs carry this lane's one VTID.
VTID from PLAN-SPAR; never by hand.

## Log
### 2026-11-18T10:30Z · kiro-exafyltd-202611181004-a185 · created (ready)
Lane created with the plan.
### 2026-11-18T12:00Z · kiro-exafyltd-202611181004-a185 · ready
Replacement lane branches built on main bbe90b713. Expanded writes gated off on web, mobile and the gateway tool; rollback preserves member reactions.
