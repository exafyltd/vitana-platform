# Acceptance: chat-reactions-full-emoji/reactions (vitana-platform, gateway)

VTID: pending (VTID_PLACEHOLDER). Moves to docs/validation/<VTID>/ when the official VTID is issued.

AC-1. With REACTION_EXPANDED_ENABLED unset (default) the ORB react_to_message tool adds only the six quick reactions; removals use the full set.
TEST: npx jest test/orb/reaction-expanded-gate.test.ts

AC-2. With the flag on, any emoji of the shared 181-emoji set is added; legacy bare heart normalized; the cap error is reported in words; 23505 is "already reacted".
TEST: npx jest test/orb/reaction-emoji-full-set.test.ts

AC-3. The voice payload and tool catalog change only in the react_to_message description and parameter text.
TEST: npx jest test/orb/live/characterization test/orb/latency/vtid-04542-voice-payload-identity.test.ts

AC-4. DATABASE_SCHEMA.md documents message_reaction_emojis, message_reactions_emoji_fk and message_reactions_cap.
TEST: npx jest test/orb/reaction-emoji-full-set.test.ts (list parity pin with vitana-v1)
