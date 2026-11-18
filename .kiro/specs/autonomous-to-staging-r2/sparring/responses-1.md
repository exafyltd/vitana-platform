# Responses — round 1 (session 87068fbf)

```json
[
  {"finding_id": "R1-F1", "disposition": "accepted", "rationale": "Plan §3.1.3 now fixes the permission sets: top level contents: read; job invariants exactly contents: read + pull-requests: read; job report (needs: [invariants], if: failure()) exactly contents: read and the only job naming a secret. workflow-trigger-check.test.mjs is rewritten to parse jobs and assert each, with a mutation per assertion (§5)."},
  {"finding_id": "R1-F2", "disposition": "accepted", "rationale": "Option (a), strict: for protected-file accepts any merge commit or non-lane-file commit after the reviewed head voids the accept. Implemented as a new protectedReviewCurrent wrapper used only by the protected-accept walk; reviewCurrent and single-review behaviour are unchanged. The plan states it is a deliberate behaviour change for protected files. governance.ts mirrors it with protectedReviewOnCurrentHead."},
  {"finding_id": "R1-F3", "disposition": "accepted", "rationale": "parseReviewEntry is extended to return session (Collab-Session); protectedAcceptModels in land-guard.mjs and governance.ts require two distinct models and two distinct sessions and exclude builder sessions from the lane log; fixture cases added (§5)."},
  {"finding_id": "R1-F4", "disposition": "accepted", "rationale": "Option (b): the audit runs on the job's own checkout with fetch-depth: 0, fetches refs/pull/<n>/head per protected squash merge, checks the squash tree equals the PR head tree, and runs the imported land-guard functions (localAfter, protectedReviewCurrent, protectedAcceptModels). Tested on a fixture history in a temp repo."},
  {"finding_id": "R1-F5", "disposition": "accepted", "rationale": "§3.1.1 now names all four copies with file:line; the working-tree invariant test runs in the lane PR itself, so a mismatch fails before main."}
]
```
