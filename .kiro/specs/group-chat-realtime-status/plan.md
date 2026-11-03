---
change_class: standard
---
# plan(group-chat-realtime-status): group chat messages reach an open thread late; reconnect safety and latency measurement
Author: Kiro, seat `exafyltd`, session `kiro-exafyltd-202611030923-a395`. Code repo: `exafyltd/vitana-v1` (area
`messenger`). The spec lives in vitana-platform because PLAN-SPAR only runs here. Premises pinned to vitana-v1
`origin/main` at plan time and to the lane branch `kiro/groupchat-realtime-status` (commit `90142e0c5`, PR #1560, draft).
Detail: `tasks.md`; lane file under `lanes/`.

<!-- plan:begin -->
## Goal
The owner reports that new messages in the Maxina/Vitana messenger appear late, unlike Telegram, WhatsApp or Slack.
This plan covers the group chat thread first. Its goal is that a message from another member appears in an open group
thread within about a second while the connection is up, and that a dropped connection recovers without waiting for a
timer. Measurement comes first so the owner can see which cause applies on a real device.

## Today (evidence from code on the vitana-v1 branch, read-only)
1. **Group thread live path.** `src/pages/messages/GroupChat.tsx:288-299` subscribes to Supabase Realtime INSERTs on
   `chat_messages` filtered by `group_id`. Each event calls `loadMessages()`, a full request for the latest 100 rows
   (`fetchGroupMessages(groupId, 100)`).
2. **No connection-state handling.** Before the lane branch, the `.subscribe()` call (`GroupChat.tsx:302`) had no
   callback. A dropped subscription was not detected, and nothing reloaded the thread on reconnect. The only recovery
   was the fallback poll at `GroupChat.tsx:67` (`POLL_INTERVAL_MS = 8000`, `setInterval` at line 317).
3. **Direct messages already handle drops.** `src/hooks/useGlobalMessages.ts` tracks `SUBSCRIBED` / `CHANNEL_ERROR` /
   `CLOSED` / `TIMED_OUT`, backfills after a reconnect, and runs a 6 s fallback poll only while disconnected
   (`useGlobalMessages.ts:2054-2060`). Group chat does not have this.
4. **Thread list poll.** `src/hooks/useChatGroupsAsThreads.ts:26` polls every 10 s. Out of scope for this lane.
5. **Lane branch state.** Commit `90142e0c5` on `kiro/groupchat-realtime-status` already contains a candidate change to
   `GroupChat.tsx` (status tracking, one backfill reload after a drop, opt-in `localStorage["vitana:chat-latency"]`
   logging). It has no VTID, no test and no `Collab-Lane` trailer. PR #1560 fails two PR-GATE checks for exactly that
   reason: `change-suite` (title names no VTID) and `Lane scope` (no `Collab-Lane` trailer). Its typecheck count and
   the 30 existing GroupChat tests were unchanged by it.
6. **Unverified premise: the realtime publication.** The vitana-v1 migration
   `supabase/migrations/20260618110546_chat_messages_realtime_publication.sql` adds `chat_messages` to the
   `supabase_realtime` publication. Whether that migration is applied to the database the app uses was not verified in
   this plan. The session did not query the database: production queries are forbidden, and staging shares the
   production database. The owner (or CI with the owner's approval) must confirm it. If it is not applied, group chat
   has no realtime path and the fix in this plan is not sufficient; the plan then stops for the owner (see Risks).
7. **Scope of the Supabase Realtime connection on mobile.** The app runs in a wrapper (`isAppilix()` in
   `useGlobalMessages.ts`). Whether the OS suspends the socket in the background is a device fact that only a device run
   can show. This plan adds the measurement for it, not a fix.

## Change (lane `groupchat-realtime`, vitana-v1, `executor: kiro`, seat `exafyltd`)
1. **Test first (red on base).** Add `src/pages/messages/GroupChat.realtime-reconnect.test.tsx` (Vitest + Testing
   Library, in the style of `GroupChat.vtid-04921.test.tsx`, which mocks `realtimeChannel`). Cases:
   a. the thread reloads once after the subscription reports `CHANNEL_ERROR`, `CLOSED` or `TIMED_OUT` and then
      `SUBSCRIBED` again;
   b. no reload happens on the first `SUBSCRIBED`;
   c. a realtime INSERT event triggers a reload (regression guard for today's behaviour).
   Run on `origin/main`: case a must fail, naming `GroupChat.tsx`, not a setup or parse error. Output goes to
   `docs/validation/<VTID>/red-on-base.txt`.
2. **Keep the lane branch change** (commit `90142e0c5`) as the implementation. It stays inside `GroupChat.tsx`:
   - `subscribe((status) => …)` tracks drops and runs one `loadMessages()` after the next `SUBSCRIBED`;
   - the INSERT handler does not change its reload behaviour (still a full `loadMessages()`);
   - latency logs run only when `localStorage["vitana:chat-latency"] === "1"` and print the `created_at`-to-receipt
     delay and the reload duration. The `created_at` value comes from the server clock, so device clock skew shifts the
     first number. The logs carry no message content.
3. **Green on head.** The new test passes; the 30 existing GroupChat tests still pass; `tsc --noEmit` error count does not
   rise above the base count (176 at plan time); ESLint shows no new warning in `GroupChat.tsx`.
4. **Staging proof (rule 47).** `docs/validation/<VTID>/staging-tests.json` with `service: community-app` and one test
   `kind: "existing"` pointing at `tests/e2e/staging/vtid-04921-group-chat-latest.staging.spec.ts`. That suite is
   read-only (rule 48). It must be checked against the existing suite's own write guard before the lane is marked
   verified.
5. **Commit trailers.** Lane commits carry `Collab-Session` and `Collab-Lane: group-chat-realtime-status/groupchat-realtime`.
   The lane-branch commit `90142e0c5` predates this plan and keeps its message. A new commit adds the trailers and the
   test, so the `Lane scope` check finds a trailer and `change-suite` finds the VTID in the PR title. The branch is not
   rewritten (no force push, no rebase of a pushed branch).

## Lanes
- `groupchat-realtime` (vitana-v1, `executor: kiro`, seat `exafyltd`, area `messenger`): changes 1–5.
  Paths: `src/pages/messages/GroupChat.tsx`, `src/pages/messages/GroupChat.realtime-reconnect.test.tsx`,
  `docs/validation/**`. `depends_on: []`. No file is shared with another open lane. The messenger area's other open work
  (`messenger-paste-enter`, `vitana-chat-markdown` in `.kiro/specs`) touches other files.

## Owner measurement (not a lane)
After the lane is verified on staging, the owner runs the device check: one open group thread, a second account sends a
message, the device is on Wi-Fi and then on cellular, and once with the app backgrounded for two minutes. The owner sets
`localStorage["vitana:chat-latency"] = "1"` on the device, which needs no build. The numbers go into
`docs/validation/<VTID>/device-latency.md`. The session writes that file from the owner's report and does not run the test
itself.

## Out of scope
- Direct messages (`useGlobalMessages.ts`). Already tracks drops; not changed here.
- The gateway SSE relay (`services/gateway/src/routes/realtime-relay.ts`, `chat-messages-poller.ts`). Feature-flagged
  off and polls every 3 s. Turning it on is a separate decision; this plan does not touch it.
- The `chat_messages` publication migration and any database change. A database change needs its own owner approval
  (`collaboration.md` §7d).
- Push notifications and the background-socket behaviour. Measured here, fixed in a later plan if the device run shows it.
- The thread-list poll in `useChatGroupsAsThreads.ts`.

## Test plan
- Lane: `npx vitest run src/pages/messages/GroupChat.realtime-reconnect.test.tsx` fails on `origin/main` (case a) and
  passes on the lane head. The 30 existing GroupChat tests pass. Commands in `docs/validation/<VTID>/commands.log`.
- CI: PR-GATE, `change-suite` (staging-tests.json present) and `Lane scope` pass on the lane PR.
- Staging: the community-app staging suite named in change 4 passes on the merge commit (STAGING-VERIFY).

## Risks
- If the `chat_messages` publication is not applied, the realtime path never fires for group messages. Only the 8 s
  poll delivers them, and this lane does not change that. The owner must confirm the publication before device testing
  is read as a result. Fixing the publication is a database change and stops here for the owner.
- A reload on every event remains a full 100-row request. On a busy group that adds load. Replacing it with a
  cursor-based append is a later plan, after the measurement shows whether it matters.

## Decisions taken
- The change is kept on the existing branch rather than rewritten, because the branch is pushed. Lane identity comes
  from the trailers and the PR title, as `collaboration.md` §3 allows.
- A test is added even though the lane is small. The vitana-v1 standing rule (rule 47, "no suite, no merge") requires it.
- The spec sits in vitana-platform and the code PR in vitana-v1, following `ci-dockerhub-mirror`.
<!-- plan:end -->
