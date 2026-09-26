# VTID-04640 — German "Erinnerung": memory vs reminder

Owner report (2026-09-26): in German voice sessions, asking Vitana to remember
something ("Ich möchte, dass du dich erinnerst", "Was hast du in deinem
Gedächtnis?") created a reminder instead of storing or recalling a memory.
German uses *erinnern / Erinnerung* for both. The TOOLS section only showed
English examples for `set_reminder` ("remind me at 8pm …") and the tool's own
description lists "erinnere mich um X", so the model mapped the German word to
the reminder tool.

## Change

One TOOLS line in `buildLiveSystemInstruction` (every surface, every provider):

- `set_reminder` only when the member wants to be prompted later **at a time
  they said** ("remind me at 8pm", "erinnere MICH um …").
- "erinnere DICH", "merk dir", "was hast du im Gedächtnis", "woran erinnerst du
  dich" are memory: `remember_fact` stores, `search_memory` recalls.
- Unsure → ask one short question (memory or reminder). Written as intent, not
  a spoken sentence (NEVER rule 41).

The old set_reminder line repeated what the tool descriptions already say (UTC
computation, human_time confirmation, find_reminders counting). It was folded
into the new line so the TOOLS region stays under its 4,500-byte budget
(VTID-04534). `set_reminder`/`find_reminders`/`delete_reminder` are on the
catalog priority list, so their full descriptions are always sent.

Tool catalog: unchanged (tools_bytes / tools_sha256 identical in the
VTID-04542 payload-identity manifest). Instruction: +~0.3 KB per scenario,
largest well under the 30 KB instruction budget.

AC-1 The German memory phrasings map to remember_fact / search_memory.
TEST: services/gateway/test/orb/live/instruction/vtid-04640-erinnerung-disambiguation.test.ts

AC-2 set_reminder is limited to a time the user said; unclear intent asks.
TEST: services/gateway/test/orb/live/instruction/vtid-04640-erinnerung-disambiguation.test.ts

AC-3 The delete_reminder confirmation rule is kept.
TEST: services/gateway/test/orb/live/instruction/vtid-04640-erinnerung-disambiguation.test.ts

AC-4 The TOOLS region stays within its byte budget.
TEST: services/gateway/test/orb/live/instruction/vtid-04534-shrink-before-drop.test.ts

AC-5 Only the instruction changes; tool payloads are byte-identical.
TEST: services/gateway/test/orb/latency/vtid-04542-voice-payload-identity.test.ts

## Not verified

No spoken German session was run (needs a real device). The first real signal:
a German member saying "merk dir …" / "erinnere dich …" gets `remember_fact`
(`orb.live.tool.executed` tool=remember_fact), not `set_reminder`.
