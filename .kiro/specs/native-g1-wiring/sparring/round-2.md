# Sparring round 2 — in_progress

Session: `185a911c-d850-4c75-bdd6-89c59beb4e3a` · plan hash `1843e194ed6f19f6867e1a0663fa132fa0e6513c782850342e541f05e83e1db1`

## Summary

All three R1 findings were accepted and correctly addressed. One new major finding: the plan places `NATIVE-CI.yml` in `vitana-platform` with `push`/`pull_request` triggers filtered to `apps/mobile/**`, but `apps/` does not exist in `vitana-platform` (confirmed 404). GitHub Actions workflows only auto-trigger on events in their own repository, so those path-filtered triggers will never fire. Only `workflow_dispatch` will work. Additionally the plan is silent on how the CI job actually checks out the vitana-v1 codebase where `apps/mobile/` lives.

## Findings

### R2-F1 [major]

NATIVE-CI.yml is specified to live in vitana-platform and to trigger on `push`/`pull_request` filtered to `apps/mobile/**`. But `apps/` does not exist in vitana-platform at the pinned commit (GitHub returned 404 when listing that directory). GitHub Actions workflows only fire on events in their own repository; a push to `apps/mobile/` in vitana-v1 will never trigger a workflow whose `on: push: paths: apps/mobile/**` lives in vitana-platform. The push/PR auto-triggers are permanently dead letters. The plan also never describes how the CI job steps check out vitana-v1 to actually run `npm ci`, `npm test`, and `npm run bundle` from `apps/mobile/`.

- `exafyltd/vitana-platform:.github/workflows/MOBILE-DEVICE-E2E.yml:21` — name: MOBILE-DEVICE-E2E

on:
  workflow_dispatch:
- `exafyltd/vitana-platform:.github/workflows/PLAN-SPAR.yml:81` — node base/scripts/collab/plan-spar.mjs --dir head --base-sha "$BASE_SHA" --repo "${{ github.repository }}"

Suggestion: Either (a) accept that only `workflow_dispatch` is available from vitana-platform and state that explicitly — removing the dead `push`/`pull_request` path-filter triggers — or (b) place NATIVE-CI.yml in vitana-v1 where `apps/mobile/` lives (which requires a rationale for why that doesn't violate the governance-path rule, e.g. mobile-native CI is not a governance file), or (c) add a `repository_dispatch` event emitter in vitana-v1 that calls this workflow. Whichever option is chosen, the lane acceptance criteria for `native-ci-workflow` and `build-profiles` must spell out the cross-repo checkout step so the CI job can actually run `npm ci` / `npm test` from `apps/mobile/`.

## Acknowledgements of earlier responses

- R1-F1: acknowledged — Fixed correctly. CLAUDE.md lines 599–606 confirmed: the single-Supabase rule is at rule 31 in the test-account section with VTID-03506 at line 606. The plan now cites by line number and notes the duplicate-rule-31 ambiguity.
- R1-F2: acknowledged — Fixed correctly. Confirmed at the pinned commit that plan-spar.mjs line 193 still has no extra_refs, PLAN-SPAR.yml line 81 still passes no vitana-v1 SHA. The revised plan correctly marks spar-vitana-v1-ref as STILL PENDING and blocks approved→executing until a fresh session verifies a successful read_file against vitana-v1.
- R1-F3: acknowledged — Accepted disposition is sound. Decisions now carry inline vitana-v1 code citations (env.ts, provider.ts, app.config.ts, orb-fake-gateway/server.js). These remain planner-read until R1-F2 lands, but the grounding is no longer solely design.md.

## Next

Planner: answer every finding above in `sparring/responses-2.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
