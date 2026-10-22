```json
[
  {
    "finding_id": "R1-F1",
    "disposition": "accepted",
    "rationale": "Accepted on the operative point: vitana-v1 was not forwarded to this session, so no load-bearing premise (the 22-row ledger partition, the class-A/class-B closures, the ERROR-level i18n/no-raw-locale-call rule, the 22 web destinations, the 12+4+6 lane split) could be verified. Root cause confirmed in code: spar_refs is applied only at client.create (scripts/collab/plan-spar.mjs:312-320); client.round (:333) forwards no extra_refs, and the round-1 session was created before spar_refs reached the branch, so the gateway session carries no vitana-v1 binding. On the partner's secondary observation — that .kiro/specs/native-wave2-events-calendar is absent at the pinned BASE commit 84fc0ca — that is expected: a plan PR's spec folder lives on the PR HEAD branch, and PLAN-SPAR reads handoff.md from the checked-out plan tree (plan-spar.mjs:286, `path.join(spec, 'handoff.md')`), not from the base commit; handoff.md IS present on this branch and declares `spar_refs: - exafyltd/vitana-v1: main`. The fix that actually restores access is a FRESH client.create: this commit changes the plan text so that, once this non-infra session escalates at the round cap, the replan branch (plan-spar.mjs:307) creates session #2 (1 < MAX_SESSIONS 2) with extra_refs applied and the spec folder present on HEAD.",
    "deferred_to": ""
  },
  {
    "finding_id": "R1-F4",
    "disposition": "accepted",
    "rationale": "Accepted on the mechanism: because this session was created without vitana-v1 pinned and client.round never forwards extra_refs, adding spar_refs to handoff.md could not take effect for this already-created session — the partner correctly observed vitana-v1 remained unreadable. The spar_refs block IS present in this branch's handoff.md (front matter `spar_refs: - exafyltd/vitana-v1: main`); the partner read the BASE commit where the spec folder does not yet exist, which is why it reported 404. The determinism suggestion (pin a concrete 40-hex vitana-v1 SHA rather than `main`) is noted but deliberately not adopted here: `main` matches the sibling native-wave2-home-feed-news declaration that converged after PR #4201, and PLAN-SPAR resolves `main` to a concrete SHA at client.create time, so the forwarded ref is already a pinned commit per session. The effective fix remains the fresh-session (replan) path set up by this plan-text change.",
    "deferred_to": ""
  },
  {
    "finding_id": "R1-F2",
    "disposition": "accepted",
    "rationale": "Acknowledged by the partner as sound in principle (wholesale regeneration of the two generated files plus an append-only keep-both manifest, with a serialized depends_on fallback) and deferred to merits verification once vitana-v1 is readable. Accepted on that basis: no plan change is required; the fresh vitana-v1-pinned session verifies the plan.md and core-closure.mjs behavior it depends on.",
    "deferred_to": "fresh vitana-v1-pinned sparring session (replan branch)"
  },
  {
    "finding_id": "R1-F3",
    "disposition": "accepted",
    "rationale": "Acknowledged by the partner as needing next-round verification, impossible this round because vitana-v1 (vcal/time.ts, liveRoom.ts, the ESLint config) is unreadable. Accepted: the premises stand for independent verification by the fresh vitana-v1-pinned session; no plan change is required now.",
    "deferred_to": "fresh vitana-v1-pinned sparring session (replan branch); flagged for owner/operator if replan does not auto-fire"
  }
]
```
