# Tasks — group-chat-realtime-status
<!-- lane: groupchat-realtime -->
Repo `exafyltd/vitana-v1`. Code starts only after the VTID is allocated by CI PLAN-SPAR (plan § Lanes).
- [ ] T1 Test first: write `src/pages/messages/GroupChat.realtime-reconnect.test.tsx` (plan § Change 1). On
      `origin/main` run `npx vitest run src/pages/messages/GroupChat.realtime-reconnect.test.tsx`, save the output to
      `docs/validation/<VTID>/red-on-base.txt`. Case (a) must fail on the reload assertion in `GroupChat.tsx`, not on a
      setup or parse error. Cases (b) and (c) may pass on base.
- [ ] T2 Cherry-pick commit `90142e0c5` onto the new lane branch (plan § Change 5). It changes `GroupChat.tsx` only: status-aware subscribe
      callback with one reload after a drop, opt-in `vitana:chat-latency` logs. Change nothing else in the file.
- [ ] T3 Green on head: the new test passes; the 30 existing GroupChat tests
      (`npx vitest run src/pages/messages/`) pass; `npx tsc --noEmit -p tsconfig.app.json` reports no more errors than
      the base count (176 at plan time, none in `GroupChat.tsx`); `npx eslint src/pages/messages/GroupChat.tsx` shows
      no new warning. Commands and summaries in `docs/validation/<VTID>/commands.log`.
- [ ] T4 `docs/validation/<VTID>/staging-tests.json` (UTF-8, no BOM): `service: community-app`, one test
      `kind: "existing"`, `ref: "tests/e2e/staging/vtid-04921-group-chat-latest.staging.spec.ts"`. Before writing it,
      read that spec and confirm it only reads (no non-GET request to Supabase or the gateway).
- [ ] T5 Commit trailers on every lane commit: `Collab-Session: <session id>` and
      `Collab-Lane: group-chat-realtime-status/groupchat-realtime`. Run `preflight.mjs` on the head before pushing.
- [ ] T6 Open the PR from the new lane branch `kiro/group-chat-realtime-status/groupchat-realtime` (cut from origin/main), then close PR #1560 as superseded. Title
      `VTID-xxxxx (group-chat-realtime-status/groupchat-realtime): fix group chat reload after realtime drops`. On its
      head `PR-GATE`, `change-suite` and `Lane scope` pass. Keep it a draft until the reviewer agent accepts.
- [ ] T7 Owner device check (not a Kiro task): owner records latency on a real device, per plan § Owner measurement.
      Kiro writes `docs/validation/<VTID>/device-latency.md` from the owner's report only.

Acceptance:
- Change types: UI (chat thread behaviour), Tooling (test), Validation records.
- **Outcome** — a group chat thread reloads once after a dropped realtime subscription reconnects, and the latency logs
  appear only when the device flag is set.
- **States / Surfaces / Locales / Accessibility** — n/a: no new visible UI, no new strings, no layout change. The
  latency logs go to the console, not to the user.
- **Contract** — n/a: `fetchGroupMessages`, `sendGroupMessage` and the realtime channel name `group_chat_<id>` are
  unchanged.
- **Staging proof** — the existing read-only community-app suite named in T4 passes on the merge commit.
- Red on base for the reason fixed (case a), green on head; diff only inside the lane `paths`; no test skipped or
  loosened; no production or live-system write; files UTF-8 without BOM.
