# Responses to sparring round 1

Premises re-checked on vitana-v1 `origin/main` `a763b4f01` (many Wave 2 lanes merged since the plan was written:
#1573, #1575, #1565, #1553, #1584, #1562 merged; #1566 closed unmerged; #1567 open). Every follow-up is still open on main;
the plan block, `tasks.md`, `design.md` and the lane files now say which PRs are merged and drop the "wait for open PR" gates.

```json
[
  {
    "finding_id": "R1-F1",
    "disposition": "accepted",
    "rationale": "Premise verified: link-router.ts:44-50 flush() requires deps.isSignedIn(), and auth-port.ts:55 session starts null, so reusing held/flush() would never navigate a cold-start signed-out invite. design.md §3 already named a heldPublic/flushPublic slot, but the plan block (decision 6) did not. plan.md decision 6 now specifies it: held/flush() untouched; case 'invite' calls deliverInviteLink then sets heldPublic = '/i/'+encodeURIComponent(code) and flushPublic(), which has no sign-in check; attachNavigator calls flushPublic() and flush(). tasks.md public-entry task 1 now builds the router with isSignedIn: () => false and asserts navigation to /i/ABC123 on attach (plus warm link, auth-port still receives the link, non-invite links still wait for sign-in); task 2 names the mechanism. design.md §3 notes why."
  },
  {
    "finding_id": "R1-F2",
    "disposition": "accepted",
    "rationale": "Premise verified: session.ts:355-358 treats every entry of SESSION_END_DIRECTIVES (protocol.ts:190) identically, and no native idle/ceiling timers exist (grep of src/orb on a763b4f01). plan.md decision 5 now states (a) the directive handler branches on the directive string and only end_guided_topic_teaching calls the new optional dep onGuidedTopicTeachingEnd before draining/ending, with end_conversation and end_teaching_session unchanged and pinned by a test that they emit nothing; (b) the 45 s idle-after-audio and 5 min ceiling backstops, the 5 s check, idle clock and close-after-audio trigger are new native logic in orb-controller.ts; (c) one controller reportTeachingEnd(reason) is the single emitter with the once-per-topic guard shared by all three triggers. tasks.md orb-guided-topic task 4 and design.md §2 carry the same wording."
  },
  {
    "finding_id": "R1-F3",
    "disposition": "accepted",
    "rationale": "Checked on a763b4f01: no file in tests/memory, tests/diary, tests/community or tests/ui calls configure( or jest.setTimeout( (only memory/gateway-i18n.test.tsx:130 has a plain setTimeout(res, 0) delay). community/helpers.tsx (imports :10-17) and ui/helpers.tsx (imports :2-9) have no configure call, and every test file in those folders imports ./helpers except diary/app-config-plugins.test.ts and ui/tokens-contract.test.ts. configure is module-global and jest.setTimeout is per file, so placing both right after the imports is order-independent. plan.md decision 7 records this; tasks.md test-timeouts task 1 now has the lane re-run the grep before editing and log the result in commands.log, reconciling any hit inside the helper rather than overriding it."
  }
]
```

## Changes beyond the findings (stale premises on main, no scope change)
- plan.md "Today": re-measured on `a763b4f01`; list of what is now on main vs still absent; the journey-local `celebrate.ts`
  (VTID-05461) corrects the item 8 sentence "no `celebrate()` caller" (shared native `celebrate()` stays out of scope, decision 8
  unchanged); the alias comment in `resolve.ts` is now at `:65`.
- Decision 2 and the three lane files / `tasks.md` headers: dependencies #1573, #1575, #1565, #1553, #1584 are merged; #1566
  closed unmerged (no autopilot bar copy exists to delete; the journey VoucherModal arrived with #1565); #1567 is open and not a dependency.
- Goal, owner quote, lane `paths`, `depends_on` and VTID fields are unchanged.
- Lane files `utility-bar`, `public-entry`, `screen-backfill` still carry the old "waits for open PR" sentence: lane files cannot
  be changed on this `plan(` PR (Collab handoff: one lane per commit, branch lane `plan`), so `tasks.md` now states that it and
  `plan.md` take precedence and each lane updates its own file in its lane PR.
