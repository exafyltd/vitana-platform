# Tasks — chat-realtime-all-surfaces
Repo `exafyltd/vitana-v1`. Code starts only after the VTIDs are allocated by CI PLAN-SPAR (plan § Lanes). Every lane's
first task is its red test on `origin/main`.

<!-- lane: chat-realtime-helper -->
- [ ] T1 Red tests for `subscribeChatChannel` (state machine: first `SUBSCRIBED` emits `connected`; `reconnected` once
      after each drop; unsubscribe). Output to `docs/validation/<VTID>/red-on-base.txt`.
- [ ] T2 Implement `src/lib/chat-realtime/subscribeChatChannel.ts` with the interface in plan § Change. Latency logs behind
      `vitana:chat-latency`.
- [ ] T3 Green: helper tests, existing tests of the paths it imports, `tsc` count not above base.
- [ ] T4 `staging-tests.json` (read-only existing suite plus GET `/`).

<!-- lane: dm-global -->
- [ ] T1 Red: a DM thread reloads after `reconnected` (fails on base, which has the poll but no helper).
- [ ] T2 Move `useGlobalMessages.ts` channel to the helper. Keep the 6 s poll for the disconnected state only.
- [ ] T3 Green and staging-tests.json.

<!-- lane: tenant-threads -->
- [ ] T1 Red: the open tenant thread and the thread list refetch after `reconnected` on both channels.
- [ ] T2 Move both channels of `useTenantMessages.ts` to the helper, with refetch on `reconnected`.
- [ ] T3 Green and staging-tests.json.

<!-- lane: group-chat -->
- [ ] T1 Red: the group thread reloads once after a drop and the next `SUBSCRIBED` (the test already on PR #1592).
- [ ] T2 Re-apply the PR #1592 change on top of the helper in `GroupChat.tsx`. Close PR #1592 as superseded.
- [ ] T3 Green and staging-tests.json.

<!-- lane: legacy-messages -->
- [ ] T1 Red: `useMessages` refetches the open thread and the thread list after `reconnected` on both channels.
- [ ] T2 Move both channels of `useMessages.ts` to the helper.
- [ ] T3 Green, existing payment and wallet popup tests green, staging-tests.json.

<!-- lane: thread-list-badges -->
- [ ] T1 Red: the thread list and badge counts refetch after `reconnected`.
- [ ] T2 Move `useChatGroupsAsThreads.ts` and `useChatUnreadCount.ts` channels to the helper. Timers run while disconnected
      only, plus the existing once-per-minute reconciliation.
- [ ] T3 Green and staging-tests.json.

<!-- lane: typing-reactions -->
- [ ] T1 Red: reactions of the open message refetch after `reconnected`.
- [ ] T2 Move `useMessageReactions.ts` to the helper. `useTypingIndicators.ts` moves to the helper without a backfill
      (typing is best effort).
- [ ] T3 Green and staging-tests.json.

<!-- lane: measurement -->
- [ ] T1 `docs/validation/<VTID>/device-runbook.md` with the procedure from plan § Owner measurement (per surface).
- [ ] T2 Results template `docs/validation/<VTID>/device-results.md`. Filled only from the owner's report.

Acceptance (every lane):
- Change types: Frontend (messaging hooks and screens), Tooling (helper and tests), Validation records.
- **Outcome** — on the lane's surface, reconnect and resume catch up from the server, and live events arrive over the
  realtime channel while connected.
- **States / Surfaces / Locales / Accessibility** — n/a: no new visible UI, no new strings.
- **Contract** — the exported hook names and return shapes of the lane's file are unchanged.
- Red on base for the reason fixed, green on head; diff only inside the lane `paths`; no skipped or loosened tests;
  no production write; files UTF-8 without BOM.
