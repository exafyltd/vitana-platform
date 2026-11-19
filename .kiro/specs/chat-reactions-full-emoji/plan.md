---
change_class: standard
---
# Plan: full emoji reactions in chat (mobile, web, ORB voice tool)

change class: standard (a database migration, gateway ORB tool, vitana-v1 web and mobile code).
scope: `exafyltd/vitana-v1` and `exafyltd/vitana-platform`, one lane (`reactions`) with one VTID shared by both PRs.
existing work: vitana-v1 PR #1697 (head `11797e0d`) and vitana-platform PR #5105 (head `1f8c8c3f`), both on branch
`claude/intelligent-pascal-3ynr7i`. Their commits have no Collab trailers, so the Collab handoff check refuses them. This plan
replays the same commits from current `main` as replacement lane branches with trailers (`kiro/chat-reactions-full-emoji/reactions`
in both repos). #1697 and #5105 close only after the replacements carry every intended change.
owner: Gate 1 approved for this work (owner, 2026-11-18, Kiro Web): *"Keep the full 181-emoji set, the six shortcuts,
and the cap of six distinct reactions per user per message. Preserve existing reactions and verify that legacy heart
variants display and toggle as one reaction."* VTIDs come from this plan's PLAN-SPAR run, never by hand.

<!-- plan:begin -->
## Goal
Members can react to a chat message with any emoji from one shared set of 181 emojis, on mobile and on web, and by
voice through the ORB `react_to_message` tool. The six quick reactions (👍 ❤️ 😂 😮 🙏 🎉) stay the shortcuts. A member
can have at most six different emojis on one message; the seventh is refused with a clear message, and removing a
reaction is never capped. Existing reactions are kept. A legacy bare heart (U+2764 without U+FE0F) and the canonical
heart (U+2764 U+FE0F) are one reaction: one chip, one count, and one tap toggles it.

## Today (`origin/main`)
- Database: `message_reactions.emoji` has a six-value CHECK (vitana-v1
  `supabase/migrations/20250918121049_bd093f57-f6c1-4669-92f9-5fe63bfba473.sql:5`, the heart is U+2764 U+FE0F), primary
  key `(message_id, user_id, emoji)`, RLS insert/delete own rows, trigger `trg_notify_reaction` (push on insert).
  Read-only check of the live table (2026-11-18): 352 rows, all six canonical forms, no bare heart, no lookup table.
- Web: `src/hooks/useMessageReactions.ts:24` allows only the six; `src/components/messages/MessageContextMenu.tsx:42`
  shows five shortcuts (no 🎉).
- Mobile: `apps/mobile/src/screens/chat/data/useReactions.ts:13` allows only the six.
- Gateway: `services/gateway/src/services/orb-tools/messaging-depth-tools.ts:72` allows only the six (`:448`).

## What PR #1697 / #5105 already do (heads above)
- One list `reaction-emojis.json` (181 emojis, `quick` = the six), byte-identical in vitana-v1
  `src/lib/reactions/`, `apps/mobile/src/screens/chat/data/` and gateway `services/gateway/src/services/orb-tools/`;
  each copy is pinned by SHA-256 in a test. Helpers `normalizeReactionEmoji` (strip U+FE0F, map to the canonical entry),
  `REACTION_CAP_ERROR = 'reaction_cap_reached'`, `MAX_DISTINCT_REACTIONS_PER_USER = 6`.
- Migration `supabase/migrations/20261117120000_message_reactions_full_emoji.sql` (vitana-v1): lookup table
  `message_reaction_emojis` seeded with the 181 (RLS, select-only for `authenticated`), FK
  `message_reactions_emoji_fk` added before the CHECK is dropped, BEFORE INSERT trigger `message_reactions_cap`
  (advisory lock per message+user; re-adding an emoji already present is a duplicate, not a new distinct emoji;
  raises `reaction_cap_reached`, SQLSTATE P0001). Widening only: every existing row is in the seed.
- Web and mobile: the reaction drawer / context menu gets a "+" that opens the existing emoji sheet, behind
  `REACTION_PICKER_ENABLED` (one constant per client, **false**). Adds normalize before writing; the cap error shows
  `chatNative.reactions.capReached` (11 locales, plus `moreEmojis`). Summaries group by canonical form.
- Gateway: `react_to_message` accepts the shared set, normalizes, explains the cap refusal; tool description and
  parameter text name the set; voice payload snapshot and hash manifest regenerated (only those fields changed).
- DATABASE_SCHEMA.md documents the table, FK, trigger and canonical form.

## Changes this plan adds on top
1. **Legacy heart toggles as one (bug in both heads).** Removal compares the canonical form but deletes with it:
   - web `src/hooks/useMessageReactions.ts:98-99` (head `11797e0d`) finds the target with `r.emoji === emoji`, so a
     stored bare heart is never found and the chip cannot be toggled off; `:114` deletes `.eq('emoji', emoji)`;
   - mobile `apps/mobile/src/screens/chat/data/useReactions.ts:94` deletes `.eq('emoji', emoji)` (canonical) while
     the target row may be bare, so the delete matches nothing and the reaction comes back on refetch.
   Fix: match rows by `normalizeReactionEmoji(r.emoji) ?? r.emoji`, delete with the target row's stored `emoji`.
   Tests first, recorded red on `11797e0d`: web `src/hooks/useMessageReactions.legacy-heart.test.ts`, mobile
   `apps/mobile/tests/inbox-chat/conversation-chat/reactions-legacy-heart.test.tsx` (one chip with count 2; toggle-off
   deletes the stored form; a bare-heart add writes the canonical form).
2. **Cross-client check against an isolated database.** Opt-in tests that run only when `ISODB_REST_URL` is a
   `127.0.0.1` URL (skipped in CI and normal runs): mobile half
   `apps/mobile/tests/inbox-chat/conversation-chat/reactions-cross-client.isolated.test.tsx` (real `MessageBubble`:
   long-press, "+", pick 🍎 outside the six, row in the database, fresh bubble shows it; after the web half, a fresh
   bubble shows no 🍎 and the existing heart once) and web half `src/lib/reactions/reactions-cross-client.isolated.test.tsx`
   (real `useMessageReactions` + `ReactionCluster`: both members see 🍎, the owner's tap removes the row; a bare heart is
   stored canonical, shows as one chip with count 2 and toggles only the member's own row; a seventh distinct emoji is
   refused by the database with the cap message, removal works). The harness (local Postgres 17 + PostgREST 12, schema
   built from the repo's own migrations: the original table verbatim, §3 of `20260522120000_vtid_03089_chat_access_stable.sql`
   verbatim, then this migration verbatim, with existing rows checked identical before/after) lives in
   `docs/validation/<VTID>/outputs/isolated-db/` with its run log. No shared or live system is touched.
3. **Migration rollback procedure** (preserve by default). Rolling back never deletes a member's reaction.
   Step 1, always: disable expanded writes (gateway `REACTION_EXPANDED_ENABLED=false`, web and mobile
   `REACTION_PICKER_ENABLED=false`); the wider schema stays. Step 2, only when the precheck (reactions outside the six) is
   zero: the transaction in the migration header, which refuses itself if any outside row exists. If the precheck is not
   zero, keep the schema and expanded writes disabled. Rehearsed on the isolated database with the procedure text
   taken from the file (`docs/validation/chat-reactions-full-emoji/outputs/rollback-rehearsal.txt`).
   Deleting outside-six rows to make a rollback possible is not part of this plan.
4. **Web pickers usable on desktop and phone (found by browser check of `11797e0d`).**
   - Desktop: the "+" sits inside the modal Radix context menu, which sets `pointer-events: none` on the body; the
     picker popover inherits it, so no emoji in it can be clicked in a real browser (jsdom does not model this).
     Fix: `EmojiPicker` gets `contentClassName`; the reaction picker passes `pointer-events-auto`.
   - Phone web: the long-press drawer (`src/components/messages/MessageBubble.tsx:1607`, hardcoded six) has no "+".
     Fix: use `QUICK_REACTIONS` and add the same "+" behind `REACTION_PICKER_ENABLED`, popover `z-[130]
     pointer-events-auto` above the drawer (`z-[120]`).
   - The web picker's recents/seed include five emojis outside the set (😎 👏 🙌 💯 ✨), which a reaction pick would
     silently ignore. Fix: `EmojiPicker` gets `allowed`; the reaction pickers pass `isSupportedReactionEmoji`
     (the composer picker is unchanged).
   Test first, red on `11797e0d`: `src/components/messages/MessageBubble.reaction-picker.test.tsx`; plus targeted
   Playwright screenshots (1400×900, 390×844, flag off and on) from a local harness that blocks every non-local host.
5. **Evidence and suites** under `docs/validation/<VTID>/` in both repos: `acceptance.md`, `commands.log`,
   `outputs/`, `scope.json`, `staging-tests.json` (read-only: vitana-v1 `npx vitest run src/lib/reactions
   src/hooks/useMessageReactions.legacy-heart.test.ts`; gateway `npx jest test/orb/reaction-emoji-full-set.test.ts`).
   PR titles `VTID-xxxxx (chat-reactions-full-emoji/reactions): …`, PR bodies with the validator declarations.

## Interfaces
- Shared list: `reaction-emojis.json` `{ quick: string[6], emojis: string[181] }`, canonical forms; the three copies
  change together (SHA pins in `src/lib/reactions/reactionEmoji.test.ts`, the mobile `reactions-full-set.test.ts`, the
  gateway `reaction-emoji-full-set.test.ts`); the migration seed holds the same 181 in the same order.
- Database ↔ clients: insert refused with message containing `reaction_cap_reached` (P0001) → web toast / mobile
  notice `chatNative.reactions.capReached`; gateway → a tool error the model words itself.

## Expanded reactions gate (plan change 5)
Expanded writes are off on all three paths: web and mobile `REACTION_PICKER_ENABLED=false` (hooks add only the six;
no "+"), and the gateway ORB tool `REACTION_EXPANDED_ENABLED` unset or false (adds only the six). Removals are never
gated. Turning either on is a later owner decision, and the three must change together. Tests: web
`useMessageReactions.gate.test.ts` and `MessageBubble.reaction-picker.test.tsx`; mobile `reactions-expanded-gate.test.tsx`;
gateway `reaction-expanded-gate.test.ts` (6 pass, 3 fail without the gate).

## Data planes at release
Web, mobile and ORB use Supabase VITANA in staging and production (web and mobile data API URL empty; staging gateway on
`vitana/supabase/staging/url`, `currently on: supabase`). Aurora staging backs only the isolated preview gateway and has no
`message_reactions` table. The migration targets Supabase VITANA only; the Aurora cutover adds the reaction schema later.

## Migration approval
Approval is pending. The exact file, its SHA-256, the target database, the read-only compatibility check and the rollback
rehearsal are in `docs/validation/<VTID>/migration-approval.md`. Nothing is applied before the owner approves it (stop 1).

## Rollout and stops
- Both picker flags stay **false** in this plan. Shared staging stays read-only: staging writes to the production
  database, so no staging test writes a reaction. With the flags off, members see only the sixth web shortcut (🎉) in
  the context menu; adds of the six keep working before and after the migration.
- Applying the migration is an owner stop (`collaboration.md` §7d: owner approves the file and the target database);
  in production it also needs the owner's explicit publish approval. Turning the flags on is a later change after the
  migration is live, not part of this plan.
- The gateway accepts the full set as soon as it deploys; until the migration is applied the database still refuses
  emojis outside the six (the tool returns its normal "couldn't add" error). No data changes.

## Tests and commands
- vitana-v1: `npx vitest run src/components/messages src/hooks src/lib/reactions`; `cd apps/mobile && npx jest
  tests/inbox-chat/conversation-chat`; `npm run build`; `npm run lint` on the changed files; i18n check.
- vitana-platform: `npx jest test/orb/reaction-emoji-full-set.test.ts test/orb/live/characterization
  test/orb/latency/vtid-04542-voice-payload-identity.test.ts`; `tsc` build.
- Isolated cross-client run: `docs/validation/<VTID>/outputs/isolated-db/run-isolated.sh <v1> ./cross-client.sh <v1>`.

## CI notes
- The gateway build OOM on the first head (`69b1f4e3`, runs 44058231048 / 44058231029) is not a regression: on the
  same Node 20 and a 2048 MB heap cap, `tsc -p .` on `origin/main` `67897e6c` and on the PR head both abort with
  "heap out of memory" 3/3; with a larger heap both use about 3.4 GB ("Memory used" 3 438 269K main vs 3 423 024K PR;
  +2 files, +389 JSON lines). The same step OOMs on unrelated PRs (#5108 run 44122939311). It passed on the current
  head. Gateway build-memory sizing and the preview gateway outage are separate work in their own PRs (#5110, #5112,
  #5114, #5115), not in this lane.

## Risks
- A production row outside the 181 would make the FK fail: checked read-only, none exists (all 352 rows are the six
  canonical forms); the migration aborts as a whole if that changes.
- The cap trigger adds an advisory lock per insert for one message+user: contention only between the same member's
  own concurrent taps.
- `trg_notify_reaction` keeps firing on every insert; a refused insert (cap) sends nothing.

## Unchanged
Notification trigger, RLS policies of `message_reactions`, the reactions RPCs, primary key, realtime publication, the
composer emoji picker, any other chat behaviour.

## Rollback
Revert the PRs. Database: drop trigger `message_reactions_cap` and function, re-add the CHECK only if every row is one
of the six, drop `message_reactions_emoji_fk`, drop `message_reaction_emojis`.
<!-- plan:end -->
