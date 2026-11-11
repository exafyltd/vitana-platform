# Sparring round 3 — escalated

Session: `92c6fbcd-fe6a-42c0-ac74-468c11b2fc50` · plan hash `337aba8aba80d9a5b1250806c5dd4497aedc9fc0cee13432073f1fe98b773ca0`

## Summary

Round 3 review. All three R2 findings were accepted and are reflected in the revised plan text. No rejected/deferred findings to acknowledge. I verified three key premises and found one new gap introduced by the R1-F2 bootstrap fix: the post-merge verification job the plan relies on for bootstrap safety cannot be implemented within the `machine-gate-protected` lane's declared paths, because no existing workflow runs `scripts/collab/*.test.mjs` on push to `main`.

## Findings

### R3-F1 [major]

The plan says 'A post-merge job on `main` (in `Collab tests` on push) runs the check against `main` itself and fails loudly if any invariant is missing, so the first version is verified as soon as it lands.' This mechanism was added to address R1-F2 (the bootstrap has no self-protection). However, no workflow currently runs `scripts/collab/*.test.mjs` on push to `main`: (1) PR-GATE.yml, which hosts the 'Collab tests' step (line 139-140), triggers only on `pull_request` (line 14-16), never on push; (2) CI-SCRIPTS-TEST.yml triggers on push to main but only for specific paths (lines 21-30), none of which include `scripts/collab/gate-invariants*`; (3) no other workflow runs the collab test glob on push. Furthermore, `PR-GATE.yml` is in `pipeline-b-platform`'s declared paths, not `machine-gate-protected`'s, so the lane that needs the post-merge job cannot modify the workflow that hosts 'Collab tests'. The bootstrap safety net is therefore not implementable within the lane as declared.

- `exafyltd/vitana-platform:.github/workflows/PR-GATE.yml:14` — on:
  pull_request:
    types: [opened, edited, synchronize, reopened]
- `exafyltd/vitana-platform:.github/workflows/PR-GATE.yml:139` —     - name: Collab tests
      run: node --test scripts/collab/*.test.mjs
- `exafyltd/vitana-platform:.github/workflows/CI-SCRIPTS-TEST.yml:19` —   push:
    branches: [main]
    paths:
      - 'scripts/ci/test-suite/**'
      - 'scripts/ci/plan-spar-slot/**'
      - 'scripts/collab/plan-driver.mjs'
      - 'scripts/collab/plan-driver.test.mjs'
      - 'scripts/collab/queue.mjs'
      - '.github/workflows/TEST-SUITE.yml'
      - '.github/workflows/TEST-SUITE-RERUN.yml'
      - '.github/workflows/PLAN-SPAR.yml'
      - '.github/workflows/CI-SCRIPTS-TEST.yml'

Suggestion: Either (a) add `.github/workflows/PR-GATE.yml` to the `machine-gate-protected` lane's paths so it can add a push trigger to the `collab-handoff` job, or (b) add `scripts/collab/gate-invariants*` to CI-SCRIPTS-TEST.yml's path filters and its test glob (adding `.github/workflows/CI-SCRIPTS-TEST.yml` to the lane's paths), or (c) add a new dedicated workflow (e.g. `GATE-INVARIANTS-POST-MERGE.yml`) to the lane's paths. Whichever option: make it explicit in the plan and ensure the lane's declared paths cover the workflow file it modifies.
