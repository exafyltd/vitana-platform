# Tasks — chat-reactions-full-emoji

<!-- lane: reactions -->
## Lane `reactions` (vitana-v1 PR #1697 + vitana-platform PR #5105, one VTID)
- [ ] Continue both PRs from heads `11797e0d` (v1) and `1f8c8c3f` (platform); rename titles to
      `VTID-xxxxx (chat-reactions-full-emoji/reactions): …` once PLAN-SPAR allocates the VTID.
- [ ] Legacy heart toggle fix (plan change 1), tests recorded red on `11797e0d` first.
- [ ] Cross-client isolated tests (plan change 2) and the harness under `docs/validation/<VTID>/outputs/isolated-db/`.
- [ ] Migration rollback note (plan change 3).
- [ ] Web pickers usable on desktop and phone, limited to the supported set (plan change 4), test red first, screenshots viewed.
- [ ] Evidence in both repos: `acceptance.md`, `commands.log`, `outputs/`, `scope.json`, `staging-tests.json`.
- [ ] Both picker flags stay `false`; no staging or production write; migration not applied (owner stop §7d).

**Acceptance**
- Change types: UI, Backend, Database, Integration
- **Outcome:** a member can pick any of the 181 emojis (when the picker flag is on after the migration); today, with the
  flags off, the six shortcuts work on both clients and web shows all six (🎉 added). A seventh distinct emoji on one
  message is refused with "capReached"; removal always works. A bare and a canonical heart show as one chip with one
  count and one tap toggles the member's own heart off.
- **States:** cap reached (toast / notice, optimistic row rolled back); insert error other than the cap (rolled back,
  logged); unsupported emoji input (ignored on clients, tool error in the gateway); before the migration, an emoji
  outside the six is refused by the CHECK (normal error path).
- **Surfaces:** web `MessageContextMenu` (desktop), the `MessageBubble` long-press drawer (phone web), `EmojiPicker`, `ReactionCluster` via `useMessageReactions` (desktop and the mobile web
  view); mobile `MessageBubble` reaction drawer, `EmojiSheet`, `ReactionCluster` via `useReactions`; gateway
  `react_to_message` (ORB voice).
- **Locales:** `chatNative.reactions.capReached` and `.moreEmojis` in all 11 `chatNative.json` shards (de first,
  du-form); no layout change for ar.
- **Accessibility:** the "+" has an accessible name from the catalogs (`moreEmojis`) on both clients; chips keep their
  existing labels.
- **Contract:** insert into `message_reactions` (RLS own rows) → 201, or 400 with `message` containing
  `reaction_cap_reached` (P0001) / FK violation (23503) → clients map the cap to `capReached`; gateway
  `messaging-depth-tools.ts` `tool_react_to_message` maps the cap to a tool error, 23505 to "already reacted".
- **Staging proof:** read-only suites only (`staging-tests.json`: shared list pins, normalization, legacy heart
  grouping and toggle, gateway tool tests). Not verified on staging: the write path and the cap, because staging
  writes to the production database and the migration is not applied; proven by the isolated cross-client run and
  the local migration check.
- Tests named in plan change 1 are red on `11797e0d` and green after the fix; no existing test loosened.
- The isolated tests skip unless `ISODB_REST_URL` is a `127.0.0.1` URL; they refuse any other host.
- Diff stays inside the lane `paths`; `DATABASE_SCHEMA.md` documents the change.
