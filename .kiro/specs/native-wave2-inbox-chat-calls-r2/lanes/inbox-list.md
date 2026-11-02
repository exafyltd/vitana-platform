---
lane: inbox-list
state: ready
next_actor: kiro
depends_on: []
executor: kiro
seat: exafyltd
area: frontend
reviewer_seat: hotmail
paths:
  - apps/mobile/app/(app)/inbox/index.tsx
  - apps/mobile/app/(app)/inbox/archived.tsx
  - apps/mobile/app/(app)/inbox/inspiration.tsx
  - apps/mobile/src/screens/inbox/**
  - apps/mobile/src/ports/**
  - apps/mobile/src/navigation/resolve.ts
  - apps/mobile/tests/inbox-chat/inbox-list/**
  - apps/mobile/maestro/inbox-chat/inbox-list/**
  - packages/core/manifest.json
  - packages/core/closure.generated.json
  - packages/core/src/**
  - scripts/native/mobile-ci-paths.generated.json
  - apps/mobile/parity/ledger.json
  - src/i18n/*/inboxNative.json
  - docs/validation/**
  - packages/core/extract.json
updated: 2026-11-01T17:10Z
---
# Inbox list port — `/inbox` (+ archived, inspiration) — the conversation list surfaces
Plan: `.kiro/specs/native-wave2-inbox-chat-calls-r2/` — `plan.md` (plan block) and the `tasks.md` section marked
`<!-- lane: inbox-list -->` (tasks 1–8) are authoritative. VTID: assigned by CI after PLAN-SPAR converges; do not
start before `vtid:` is set here. depends_on: none — runs in parallel with `conversation-chat` (the two lanes
communicate only through the shell's `src/ports/links` navigation port, never by importing each other's screens).

**Measured on the worktree (= origin/main):** 3 ledger rows under `"lane": "inbox-chat-calls"` for this lane, all
`not_started` — `INBOX.OVERVIEW /inbox`, `INBOX.ARCHIVED /inbox/archived`, `INBOX.INSPIRATION /inbox/inspiration`.
Web source `src/pages/Messages.tsx` (1571 lines, list/left-pane + routing shell; routes `src/App.tsx:1352-1410`),
sub-pages `src/pages/messages/Archived.tsx` (262), `src/pages/messages/Inspiration.tsx` (270); mobile list cards
`src/components/messages/mobile/MobileConversationCard.tsx` (110), `MobileConversationSkeleton.tsx` (~40),
`MobileInboxEmptyState.tsx` (~70); Spotlight list `src/components/messages/spotlight/MessagesSpotlight.tsx`; unread
`src/hooks/useChatUnreadCount.ts`, `src/hooks/useUnreadSync.ts` (both class B — re-implemented natively, NOT core).

**Goal.** Port the inbox list surfaces to native on the N3 shell at 1:1 mobile-web parity: the single-pane
conversation list (`FlatList` of `MobileConversationCard` twins with empty state, skeleton and unread badges), the
new-conversation picker + create-group sheet (member-listing exclusion inherited, R5.5), and the archived +
inspiration list screens. The inbox list fetch + unread count are re-implemented natively (class B hooks, not core).
Tapping a conversation navigates to the conversation route via `src/ports/links` (that screen is owned by
`conversation-chat` — navigate by path, do not import it). Flips the 3 parity rows to `native`.

**Acceptance (the reviewer seat checks these):**
- Requirements R1–R6 for the inbox list surfaces; mobile-web parity; `@vitana/core`-only for pure helpers (the data
  layer re-implemented natively, never in core); member-listing exclusion inherited by reusing the web query.
- `npm run typecheck`, `npm test` (list loaded/empty/error/skeleton; unread badge; new-conversation sheet opens;
  create-group member-search excludes a bot/test actor fixture; archived + inspiration loaded/empty),
  `APP_PROFILE=development npm run bundle`, `APP_PROFILE=development EXPO_OFFLINE=1 npm run deps:check` green (from
  `apps/mobile/`); React 19 `ReactElement`.
- If a pure helper is extracted to core: `node scripts/native/core-closure.mjs --check` green with the generated files
  committed in the same PR; otherwise no core files touched. `node scripts/native/parity-ledger.mjs --check` green
  with the 3 rows `native` and their routes present in `apps/mobile/app/`.
- 11 locales (ar de en es fr pl pt ru sr tr zh), new keys DE-first (du-form) then mirrored; RTL (`ar`) covered; no
  hardcoded user-visible text; no physical `left`/`right`.
- NATIVE-CI (shell source-pin + ports), PR-GATE **Collab handoff** + **Lane scope** green.
- `docs/validation/<VTID>/` has `scope.json`, `staging-tests.json` (this lane's read-only spec) and `plan-sparring.md`.
- **Device-runtime parity (task 7)** is deferred to G1 as `next_actor: owner`; not a merge blocker, recorded in this
  log and `staging-tests.json`. Read-only — never sends a message.

**Shared files.** `apps/mobile/parity/ledger.json` (this lane edits only its 3 rows), `packages/core/manifest.json` +
closure + `src/**` (only this lane's re-exports, if any pure helper), `apps/mobile/src/ports/**` +
`apps/mobile/src/navigation/resolve.ts` (shared native infra — touched additively) and the DE-first
`src/i18n/*/inboxNative.json` shard are shared by row/line with `conversation-chat`; resolve a merge conflict by
keeping both lanes' rows/keys. The `app/(app)/inbox/` folder is split by file (this lane owns the three leaf files;
`conversation-chat` owns the `u`/`g`/`t` subfolders) — no file collision.

**Never** (collaboration §7a): no VTID allocation, no merge/approve, no workflow dispatch or deploy, no writes to
Supabase/AWS, no test against production; chat never writes to a live system; staging specs are read-only; the native
app has no production profile.
## Log
### 2026-11-01T17:10Z · kiro-exafyltd-202611011658-9f52 · ready
Lane created with the plan (re-plan of `native-wave2-inbox-chat-calls/inbox-list`, PR #4269); `paths` widened to the shared native-infra files.
