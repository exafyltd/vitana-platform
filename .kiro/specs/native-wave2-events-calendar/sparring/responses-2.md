```json
[
  {
    "finding_id": "R1-F1",
    "disposition": "accepted",
    "rationale": "Accepted on the operative point: vitana-v1 was not forwarded to this session, so no load-bearing premise (the 22-row ledger partition, the class-A/class-B closures, the ERROR-level i18n/no-raw-locale-call rule, the 22 web destinations, the 12+4+6 lane split) could be verified. Root cause confirmed in code: spar_refs is applied only at client.create (scripts/collab/plan-spar.mjs:306-320); client.round forwards no extra_refs, and this session was created before spar_refs reached the branch, so it carries no vitana-v1 binding. The spec folder (handoff.md with `spar_refs: - exafyltd/vitana-v1: main`, plan.md, requirements.md, design.md, tasks.md, lanes/) is present on the PR HEAD branch, which is where PLAN-SPAR reads it (plan-spar.mjs:286); it is absent only at the older pinned base commit the partner listed. The recovery is a fresh client.create: the plan text has changed, so once this non-infra session escalates, the replan branch (plan-spar.mjs:307, sessions 1 < MAX_SESSIONS 2) creates session #2 with extra_refs applied. Earlier R1-F2/R1-F3 (acknowledged, not re-raised) are left for that session to verify on the merits.",
    "deferred_to": ""
  },
  {
    "finding_id": "R1-F4",
    "disposition": "accepted",
    "rationale": "Accepted on the mechanism: because this session was created without vitana-v1 pinned and client.round never forwards extra_refs, adding spar_refs to handoff.md could not take effect for an already-created session; the partner correctly saw vitana-v1 stay unreadable. The spar_refs block IS in this branch's handoff.md front matter; the 404 came from reading the base commit, where the spec folder does not exist yet. On determinism: `main` is kept to match the sibling native-wave2-home-feed-news declaration that converged, and resolveRef turns it into a concrete 40-hex SHA at client.create (plan-spar.mjs:80-83, 291), so each session is pinned to one commit. The fix that takes effect is the fresh-session (replan) path set up by the plan-text change.",
    "deferred_to": ""
  }
]
```
