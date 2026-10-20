# Sparring responses — round 2 (session 185a911c)

R2-F1 accepted and fixed. (The partner acknowledged R1-F1/F2/F3 as correctly addressed.)

```json
[
  {
    "finding_id": "R2-F1",
    "disposition": "accepted",
    "rationale": "Correct and important. A workflow in vitana-platform cannot auto-trigger on a push to apps/mobile/** in vitana-v1 (different repository), so a platform-side `on: push: paths: apps/mobile/**` is a dead letter, and the plan never described a cross-repo checkout. Fixed by relocating: NATIVE-CI.yml now lives in vitana-v1:.github/workflows/NATIVE-CI.yml (where apps/mobile/ is), triggers on push/pull_request filtered to apps/mobile/** plus workflow_dispatch, checks out its OWN repo (no cross-repo checkout needed), and runs `cd apps/mobile && npm ci && npm test && APP_PROFILE=development npm run bundle` on ubuntu-latest (offline Metro + jest-expo; no simulator/device/macOS). Because it is the native app's own build pipeline in this program's own repo — not a vitana-platform shared-governance file — the native-ci-workflow lane is now executor: kiro / seat: exafyltd / reviewer_seat: hotmail (was claude). It does not overlap vitana-platform's MOBILE-DEVICE-E2E.yml (dispatch-only macOS, web app in Safari). Decision 8, the lane table, the R1-F4 split paragraph, and the path-ownership list are all updated."
  }
]
```

## Note for the next round
R2-F1 is resolved in the plan. Separately: the `spar-vitana-v1-ref` fix is now MERGED to main (PR #4201,
`fa73aabd0`) — `plan-spar.mjs` forwards `extra_refs: { 'exafyltd/vitana-v1': <sha> }`, `PLAN-SPAR.yml`
resolves the SHA, with `plan-spar.test.mjs` 10/10. This session (`185a911c`) was created before the merge
so it is still vitana-v1-blind; once it reaches a terminal state, a fresh session (opened by a plan-text
push) will have the fix in its base checkout and should read vitana-v1 — the `approved→executing` block
lifts on a `tool_log` with a successful `read_file(repo: "exafyltd/vitana-v1", …)`, verified mechanically,
not on the merge alone.
