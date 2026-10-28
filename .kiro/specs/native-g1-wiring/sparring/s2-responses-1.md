# Sparring responses — session 2, round 1

The partner is right that this session could not verify the vitana-v1 premises, and right not to converge
on unverified premises (R1-F1). Root cause found and fixed: PLAN-SPAR checks out `pull_request.base.sha`,
and the ref fix (`fa73aabd0`, PR #4201) was merged to `main` but was NOT yet an ancestor of this plan
branch, so this session's base checkout still ran the old `plan-spar.mjs` without `extra_refs`. I have now
merged `main` into the plan branch, so the NEXT session's base checkout contains the fix and can read
vitana-v1. R1-F2 I can close now with direct code evidence. R1-F3 fixed.

```json
[
  {
    "finding_id": "R1-F1",
    "disposition": "accepted",
    "rationale": "Correct — do not converge in a session that could not verify the vitana-v1 premises. Root cause: PLAN-SPAR checks out pull_request.base.sha; `git merge-base --is-ancestor fa73aabd0 <plan-branch>` returned non-ancestor, i.e. the merged ref fix was on main but not yet in this branch's base, so this session's base checkout still had the old plan-spar.mjs (no extra_refs) — exactly why the partner saw 'no pinned ref for exafyltd/vitana-v1'. Fixed: merged origin/main (incl. fa73aabd0) into the plan branch, so the next session's base checkout carries the fix. The approved->executing self-block stays until a session's tool_log shows a SUCCESSFUL read_file(repo: 'exafyltd/vitana-v1'); this session does not count."
  },
  {
    "finding_id": "R1-F2",
    "disposition": "accepted",
    "rationale": "Verified in code this session, closing the partner's uncertainty: (1) services/gateway/src/services/plan-sparring/plan-sparring-service.ts validates b.extra_refs as an object whose every key is in PLAN_SPARRING_REPOS and every value matches SHA_RE, and merges it into the pinned refs — so the create-session schema already accepts extra_refs. (2) github-tools.ts exports PLAN_SPARRING_REPOS = ['exafyltd/vitana-platform','exafyltd/vitana-v1'] and its read_file/search tools accept repo: exafyltd/vitana-v1, refusing only a repo with no pinned ref. So the spar-vitana-v1-ref fix was genuinely two files (plan-spar.mjs + PLAN-SPAR.yml) with NO gateway change, as declared — confirmed by the fact that PR #4201 (those two files + a test) merged green. No scope expansion needed."
  },
  {
    "finding_id": "R1-F3",
    "disposition": "accepted",
    "rationale": "Correct inconsistency. spar-vitana-v1-ref IS merged (PR #4201, fa73aabd0), so it is done, not ready. Fixed: the Lanes table now shows it as done with the PR link, and the lane file front matter is state: done. The deep-link-push-smoke and real-g1-switch lanes correctly do not depend on it."
  }
]
```

## Note for the next round
The structural blocker is resolved end to end: the ref fix is merged AND now in this plan branch's base, so
the next PLAN-SPAR session (opened by the next plan-text push) will have `extra_refs` in its base checkout
and should read vitana-v1 for real. Convergence should happen in that session, where the ~15 vitana-v1
premises (env.ts guards, provider.ts:52 injection, app.config.ts:36, orb-fake-gateway, parity ledger,
eas.json absence, shell/UI-kit) become partner-verifiable. I will not mark the plan converged until a
session's tool_log shows a successful vitana-v1 read.
