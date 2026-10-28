# Sparring round 3 — converged

Session: `8e2ff780-0c8c-4730-9181-adb96525b085` · plan hash `85aeb40ea3a28cf4833b20ff5f6d726371cf9f970f2994dd76ae735545514f64`

## Summary

All three Round 2 accepted findings are properly addressed in the revised plan. The only new finding is a minor mislabelling in the validation-docs routing section: the plan calls `native-ci-workflow` "the one vitana-platform lane" and directs its validation docs to the platform repo, but `native-ci-workflow`'s PR creates a file in vitana-v1, making it a vitana-v1 lane whose validation docs belong in vitana-v1 (where the scope-check `own()` function would auto-allow them). Following the plan's mislabelled instruction would route those docs to vitana-platform via a commit outside the lane's PR, breaking the established pattern. The `vitana-v1-verified` sentinel mechanism (R2-F2) and the depends_on blocking are verified in queue.mjs. No blockers or majors remain.

## Findings

### R3-F1 [minor]

The plan states 'for the one vitana-platform lane, native-ci-workflow, at the platform repo root' when directing validation-doc placement. But native-ci-workflow creates vitana-v1:.github/workflows/NATIVE-CI.yml, so its PR is in vitana-v1 — it is a vitana-v1 lane, not a vitana-platform lane. The only remaining lane whose PR would land in vitana-platform is vitana-v1-verified (which writes docs/validation/VTID-*/vitana-v1-spar-evidence.md). The established convention — confirmed by reading docs/validation/VTID-05221/scope.json, one of 600+ VTID directories all resident in vitana-platform — is that validation docs live in vitana-platform. If the Claude Code executor follows the plan's mislabelled instruction to put native-ci-workflow's docs 'at the platform repo root', those docs will not be part of the vitana-v1 PR. The scope-check own() function (queue.mjs:464) auto-allows docs/validation/<vtid>/ in the PR's repo, so the correct placement for native-ci-workflow is vitana-v1, matching where its PR lands.

- `exafyltd/vitana-platform:scripts/collab/queue.mjs:462` — const own = (f) => f.startsWith(`.kiro/specs/${slug}/`) || (fm.vtid && f.startsWith(`docs/validation/${fm.vtid}/`));
    if (paths.length === 0) {
      warnings.push(`lane ${key} declares no paths ...`);
    } else {
      for (const f of changed) {
        if (own(f)) continue;
        if (!matchesAny(f, paths)) errors.push(`${f} is outside lane ${key} (paths: ${paths.join(', ')})`);
        else if (fm.executor !== 'claude' && matchesAny(f, GOVERNANCE_PATHS)) errors.push(`${f} is a governance path; lane ${key} has executor ${fm.executor || 'unset'} (needs claude)`);
- `exafyltd/vitana-platform:docs/validation/VTID-05221/scope.json:1` — {
  "vtid": "VTID-05221",
  "kind": "docs",
  "paths": [
    ".kiro/specs/multi-tenant/**",
    "docs/validation/VTID-05221/**"
  ],
  ...
}

Suggestion: Change the routing sentence to: 'for the one vitana-platform lane, vitana-v1-verified (whose PR creates docs/validation/VTID-*/vitana-v1-spar-evidence.md in vitana-platform), at the platform repo root; native-ci-workflow and all other implementation lanes commit their validation docs in vitana-v1 alongside their implementation PR.' This aligns with the actual PR targets and the scope-check own() auto-allow logic. Alternatively, adopt the established convention (all docs/validation in vitana-platform) uniformly, matching the 600+ existing VTID directories.

## Acknowledgements of earlier responses

- R2-F1: acknowledged — Properly resolved: the stale 'STILL PENDING, gates convergence' paragraph is removed from the revised plan. The plan now has exactly one stated status for spar-vitana-v1-ref (DONE, PR #4201, merged fa73aabd0) in both the lanes table and the prose.
- R2-F2: acknowledged — Properly resolved and verified in code: the vitana-v1-verified sentinel lane is added with depends_on: [spar-vitana-v1-ref], and every implementation lane lists vitana-v1-verified in its depends_on. queue.mjs line 295 confirms blocked: deps.some((d) => states.get(d) !== 'done') — the existing machinery enforces the gate without advisory prose.
- R2-F3: acknowledged — Properly resolved: Decision 7 now reads 'vitana-v1:.github/workflows/NATIVE-CI.yml' and correctly notes it is created in vitana-v1. The executor:claude / governance-path reasoning is unchanged and correct.
