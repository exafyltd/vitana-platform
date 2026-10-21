# VTID-04926 — Plan Sparring Record

- **Plan hash (sha256 of the text between the plan markers):** `ad36869f3927d37f798083c55060dbd5dfed75c17efeb17ea0b0ec35afa7ab86`
- **Change class:** standard
- **Partner:** independent `plan-sparring-partner` agent (read-only), given only the plan file path
- **Rounds:** 2 (findings → planner responses → partner re-review)
- **Verdict:** **CONVERGED** — all 8 round-1 findings closed in round 2, no new blockers or majors
- **Owner approval:** approved in the Claude Code session on 2026-10-06 ("Approve — build it")
- **Allocated after approval:** `allocate_global_vtid('claude-code','COM','MENTIONS', NULL, <plan hash>)` → VTID-04926

## Round 1 — partner findings (verbatim titles, severities)

| # | Severity | Finding | Planner answer |
|---|---|---|---|
| F1 | major | Unescaped ILIKE in the existing `useMentionCandidates`; the old client query must be removed, not kept as a fallback | ACCEPTED — removed; RPC is the only path; RPC error → empty list |
| F2 | major | Reusing `post_mention` for comment mentions conflates two actions (one toggle, "in a post" text) | ACCEPTED — separate `comment_mention` type, catalog row, enabled by migration, mapped to `posts_reactions` |
| F3 | major | One-inner-space token rule underspecified (when does the picker close? RTL?) | ACCEPTED — closes on newline, second space, 40 chars, or a spaced query with zero candidates; tests incl. Arabic + emoji |
| F4 | minor | Clarify `content_data` vs `chat_messages.metadata` | ACCEPTED |
| F5 | minor | Fan-out dedupe ordering between `chat_mention` and `new_chat_message` | ACCEPTED — single pass, sanitize before insert, id set passed to fan-out |
| F6 | minor | Call the unescaped ILIKE out as a pre-existing issue being fixed | ACCEPTED |
| F7 | minor | Name the new gateway i18n keys | ACCEPTED — `notif.chat_mention.title` (existing `notif.*` convention), all shipped locales |
| F8 | minor | Confirm no new routes / `screens.json` | ACCEPTED — none |

Partner questions (RPC vs gateway path; edits; where `mentionable` comes from) answered in the plan's "Planner responses" section below.

## Round 2 — partner re-review

> F1–F8 [closed]. No new blocker or major findings in the revision. The revised plan is internally consistent, the three questions from round 1 were answered satisfactorily … **CONVERGED** — ready for owner approval and VTID allocation.

## Final plan (with planner responses)

# Plan — @mentions that work everywhere (group chat, posts, comments)

<!-- plan:begin -->
## Problem (owner report 2026-10-06, screenshot of "Alle Beisammen" group chat)
Typing `@stefan` in a group chat does nothing: no suggestions, no link, no notification.

Verified state today:
1. **Group chat has no member mentions at all.** `MessageInput.tsx` is a plain `<Textarea>`; `MessageBubble.renderLinkedText` (`MessageBubble.tsx:560`) only linkifies URLs; the gateway send route `chat-groups.ts:238` only knows the `@vitana` bot regex (`:63`). `content_data` is already persisted in the `chat_messages.metadata` JSONB column (`:257`; frontend sends `content_data`).
2. **Posts: tagging exists but is broken in places.**
   - `PostDetail.tsx:60-67` (the deep-link target of the `post_mention` push, `/post/post/<id>`) builds the item without `mentions`, so the tagged member lands on a page where their tag is plain text.
   - Composers never prune: delete `@Anna` from the text after picking her and she still gets a "you were tagged" push (`MentionTextarea.handleSelect` only appends; `CreateContentPopup.tsx:216`, `MobileCreatePostSheet.tsx:219` send the raw list).
   - Picker has no keyboard support (↑/↓/Enter/Tab/Esc) and Enter cannot pick a suggestion.
   - `useMentionCandidates` reads `global_community_profiles` directly: read-only check on prod shows **all 3 registered test/bot accounts are offered as tag suggestions** — violates platform CLAUDE.md rule 45 (VTID-03991). No tenant scoping.
3. **Comments have no tagging.** `profile_post_comments` / `media_upload_comments` have no `mentions` column; comment input (`CommunityPostCard.tsx` ~line 400) is a plain `<input>`.
4. **Notifications:** a new notification type is auto-registered OFF by the VTID-04674 guard unless a migration enables it.

## Design — one mention engine, three surfaces

### A. Shared engine (vitana-v1)
- `src/lib/mentions.ts` (pure, unit-tested): `findActiveMentionToken(text, caret)` (moved from MentionTextarea, Unicode-aware, allows ONE inner space so `@Stefan Eh` keeps matching multi-word names; closes on newline, second space, 40 chars, or a spaced query with zero candidates), `insertMention(text, token, candidate)`, `pruneMentions(text, mentions)` (keep only mentions whose `@display_name` still appears; dedupe by user_id), `splitMentionSegments(text, mentions)` (longest-name-first match, used by renderers).
- `src/components/mentions/MentionSuggestions.tsx`: the popover list (avatar + name), `role="listbox"`, active item, selection via `onMouseDown preventDefault` + `onClick` (touch-safe, keeps keyboard open on Android/iOS), RTL-safe (`start/end`, `text-start`), i18n keys reused (`profilePosts.searchingPeople`, `profilePosts.noPeopleFound`).
- `src/hooks/useMentionComposer.ts`: owns token state, active index, key handling (↑/↓ move, Enter/Tab pick, Esc close; returns `true` when it consumed the key so the host doesn't send/submit), `select()`, and `mentions` state with pruning. Candidate source is injected:
  - `useMentionCandidates(query)` — global search, now via RPC (below);
  - local list (group roster) filtered client-side, diacritic/case-insensitive prefix-of-any-word match, max 8.
- `MentionText.renderMentions` becomes a thin wrapper over `splitMentionSegments` (same output, same `/u/<id>` link, stopPropagation).

### B. Group chat (the screenshot)
- `GroupChat.tsx` passes the roster (minus `is_bot`, minus `mentionable === false`, minus self) as `mentionCandidates` to `MessageInput`.
- `MessageInput.tsx`: when `mentionCandidates` is provided, wires `useMentionComposer` to its textarea; popover opens ABOVE the composer (it sits at the bottom of the screen); Enter picks a suggestion instead of sending while the list is open. On send, pruned mentions go in `contentData.mentions` (text messages get `contentData = { mentions }`; attachment messages merge). DMs pass nothing → unchanged behaviour.
- `MessageBubble.renderLinkedText`: plain-text segments run through `splitMentionSegments` with `message.content_data?.mentions`; mention = bold link to `/u/<id>`, own-bubble colour aware.
- Gateway `chat-groups.ts` POST send: `sanitizeMentions()` — accept array ≤ 20, keep only `{user_id (uuid), display_name (≤ 80 chars)}` whose user_id is a member of this group, not the sender, not the Vitana bot, not in `service_bot_accounts`/`notification_test_actors`, and whose `@display_name` appears in content. Store the sanitized list in `metadata.mentions` (drop whatever the client sent otherwise).
- Fan-out (single pass, `sanitizeMentions` runs before insert and its id set is passed into `fanoutGroupNotifications`): mentioned members get ONE `chat_mention` notification (title = group name, body via `tt()` "{sender} hat dich erwähnt: {snippet}" / EN, `data.url = /inbox/g/<groupId>/<messageId>` so it scrolls to the message — route already exists for reactions) and are skipped in the generic `new_chat_message` fan-out (no double push).
- Gateway GET `/:id`: each member gets `mentionable: boolean` (false for bot/service/test accounts) — one extra query on the two allowlists.
- Edit (PATCH) stays content-only; the stored mentions remain and simply stop linking if the name is edited out. Mention-on-edit notifications: DEFERRED.

### C. Posts
- `MentionTextarea.tsx` rebuilt on `useMentionComposer` + `MentionSuggestions` (keeps its public props, background preview and caret-line positioning).
- Both composers send `pruneMentions(content, mentions)`.
- `PostDetail.tsx` passes `mentions` (and `background_style`) through.
- `useMentionCandidates` calls new RPC (the old direct, unescaped table query is REMOVED — no fallback; RPC error → empty list) `search_mention_candidates(p_query text, p_limit int)` — SECURITY DEFINER, `auth.uid()` required, returns `user_id, display_name, avatar_url` from `global_community_profiles` where `is_visible`, display name ILIKE (escaped `%`/`_`), caller excluded, both allowlists excluded, and restricted to users sharing a tenant with the caller (`user_tenants`). Limit clamped 1..10.

### D. Comments
- Migration (vitana-v1): `mentions jsonb not null default '[]'` on `profile_post_comments` and `media_upload_comments`; AFTER INSERT trigger per table calling new `_dispatch_comment_mention_notifications(source, parent_entity_id, comment_id, author, mentions)` — same shape as the post one (SECURITY DEFINER, `EXCEPTION WHEN OTHERS` fail-safe, self-tag skip, tenant lookup, `_notif_user_locale`, name fallback like 20260908120000), type `comment_mention` (new; registered in E), body "… hat dich in einem Kommentar markiert", `data.source='comment'`, `url=/post/<source>/<id>`. Re-checks each tagged user server-side (shares a tenant with the author, not in either allowlist) so a hand-crafted array can't push to arbitrary users; the post trigger gets the same check. Skips the post author if they already get `post_comment`/`comment_reply` for the same comment (avoid double push).
- Comment input in `CommunityPostCard` becomes mention-aware (global candidates); `useFeedPostInteractions.addComment` sends pruned `mentions`; comment rendering uses `renderMentions`; `FeedComment` gains `mentions`.

### E. Notification type registration (platform)
- Migration: `chat_mention` and `comment_mention` rows ON in `notification_type_controls` for every tenant that has `new_chat_message` (same `source_key` convention as the seed), `chat_mention` appended to the chat category's `mapped_types`, `comment_mention` to `posts_reactions`.
- `notification-catalog.ts` row (`chat` group, `ready`, EN+DE), `TYPE_META` entry (push_and_inapp, p1, chat), gateway i18n keys EN+DE (+ es/sr/ar per catalog rules).
- vitana-v1 `notification-types.ts` `chat_mention` + `comment_mention` entries (no route; uses data.url).

### Tests
- Vitest: `mentions.test.ts` (token detection incl. emoji/punctuation/email/multi-word, insert, prune, segments), `useMentionComposer` keyboard behaviour, `MessageInput` mention flow (pick → send → contentData.mentions; Enter picks instead of sending), `MessageBubble` renders link, `PostDetail` passes mentions, comment composer sends mentions.
- Jest (gateway): `sanitizeMentions` (non-member/bot/test/self/absent-name/oversize dropped), fan-out routes mentioned members to `chat_mention` and excludes them from `new_chat_message`.
- Staging suite `docs/validation/<VTID>/staging-tests.json` + read-only Playwright spec: open a group chat as the test user, type `@` + 2 letters, assert the suggestion list renders and picking inserts the name — NO send (network guard blocks writes). Rendering of an existing tagged post on `/post/post/<id>` if one exists (read-only).

### Rollout
- Migrations applied via `RUN-MIGRATION.yml` (platform) / the per-migration apply workflow pattern (vitana-v1), only after merge, before the frontend reaches production. Frontend handles both shapes (no `mentions` → plain text), so order is safe.
- What's New entry (EN+DE) — tagging in group chats and comments is member-visible.
- No writes to production for verification; nothing posted to any real group.

### Change class: standard
### Scope
vitana-v1: `src/lib/mentions.ts`(new), `src/hooks/useMentionComposer.ts`(new), `src/components/mentions/MentionSuggestions.tsx`(new), `MentionTextarea.tsx`, `MentionText.tsx`, `useMentionCandidates.ts`, `MessageInput.tsx`, `MessageBubble.tsx`, `GroupChat.tsx`, `useChatApi.ts`(types), `PostDetail.tsx`, `CreateContentPopup.tsx`, `MobileCreatePostSheet.tsx`, `CommunityPostCard.tsx`, `useFeedPostInteractions.ts`, `notification-types.ts`, one migration, i18n shards, whats-new entry, tests, validation docs.
vitana-platform: `routes/chat-groups.ts`, a small `lib/chat-mentions.ts`(new), `notification-service.ts` TYPE_META, `notification-catalog.ts`, gateway i18n, one migration, Jest tests.

### Out of scope (DEFERRED)
- Mentions in legacy `ConversationView` group threads and in DMs (1:1 — no one else to tag).
- Mention notifications on message/post edit for chat; `@all`.
<!-- plan:end -->

## Planner responses — round 1

- **F1 ACCEPTED.** The direct `supabase.from('global_community_profiles')` query in `useMentionCandidates` is REMOVED. The RPC is the only path; if the RPC errors (e.g. migration not yet applied) the hook returns `[]` and the picker shows "no people found" — never the old unescaped query. RPC escapes `\`, `%`, `_` before ILIKE.
- **F2 ACCEPTED (option a).** New type `comment_mention`: own catalog row (`posts` group, EN "Mentioned in a comment"/DE "In einem Kommentar erwähnt"), enabled ON in the platform migration for every tenant (same as `chat_mention`), appended to the `posts_reactions` category `mapped_types` (same member toggle family, independently switchable by admins), `notification-types.ts` entry. `post_mention` stays posts-only.
- **F3 ACCEPTED.** Token rule, spec'd + tested: the token is the text after a boundary `@` up to the caret; it may contain at most ONE space; it ends (picker closes) on a newline, a second space, 40 chars, or when it contains a space and the candidate list is empty (so `@Stefan hallo` closes as soon as "hallo" matches nobody). A trailing space right after a picked mention never reopens it. Detection works on the logical string, so RTL is unaffected; tests include an Arabic name and an emoji boundary.
- **F4 ACCEPTED.** Clarified: frontend sends `content_data`; the gateway stores it in the `chat_messages.metadata` JSONB column; reads return it as `metadata`, mapped to `content_data` in `toBubbleMessage`.
- **F5 ACCEPTED.** Single pass: `sanitizeMentions()` runs before insert and returns the mentioned user_id set; `fanoutGroupNotifications(..., mentionedIds)` loops members once — mentioned → `chat_mention`, others → `new_chat_message`.
- **F6 ACCEPTED.** Called out in PR as a pre-existing issue (unescaped ILIKE + test/bot accounts exposed + no tenant scope) being fixed.
- **F7 ACCEPTED.** Gateway keys: `notifications.chat_mention.title` / `notifications.chat_mention.body` (params `sender`, `group`, `snippet`), in every locale the gateway catalog ships (en, de, es, sr, ar); exact namespace will follow the existing `tt()` key convention in that file.
- **F8 ACCEPTED.** No new routes; `/inbox/g/:groupId/:messageId` and `/post/:source/:id` already exist → no `screens.json` change.

Questions:
1. `search_mention_candidates` is a Supabase database function (SECURITY DEFINER, `search_path` pinned, `auth.uid()` required, granted to `authenticated` only), shipped as a vitana-v1 migration. Chat mentions are validated in the gateway. Two paths, both server-side enforced: the RPC limits what can be *suggested* for posts/comments; post/comment notification triggers additionally re-check the allowlists and the shared-tenant rule before notifying (so a hand-crafted `mentions` array cannot push to arbitrary users).
2. Edits: the PATCH stays content-only, so a mention typed during an edit is neither stored, linked, nor notified (the edit box is the plain correction textarea). Existing stored mentions stay; a name edited out simply stops rendering as a link. Documented as DEFERRED.
3. `mentionable` is a new boolean on each member object returned by the existing GET `/chat/groups/:id` (false for the Vitana bot and ids in `service_bot_accounts` / `notification_test_actors`); the client filters on it.
