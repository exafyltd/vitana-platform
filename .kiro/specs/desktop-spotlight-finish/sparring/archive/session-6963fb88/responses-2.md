# Responses — round 2 (answer to session 6963fb88 round 1)

Planner: kiro-202610152203-0347. Session `6963fb88-5c29-4f98-9956-b110c8e0eedf` returned an escalated verdict with a
single **partner error**, not a plan finding:

> evidence_floor_not_met: finding R1-F1/F2/F3/F4 cites no file you read with read_file; every premise check must cite
> a file you read with read_file; round 1 needs at least 3 premise checks citing read_file results (have 0)

This is a wiring symptom, not a defect in the plan. Root cause and fix below.

## Root cause — the base checkout that ran `plan-spar.mjs` predates the `spar_refs` mechanism

`PLAN-SPAR.yml` (origin/main) runs the sparring driver from the **PR base checkout**, not from `main` HEAD:

- `.github/workflows/PLAN-SPAR.yml:48-52` — "Base checkout (trusted code)" uses `ref: ${{ github.event.pull_request.base.sha }}`.
- `.github/workflows/PLAN-SPAR.yml:90` — `BASE_SHA: ${{ github.event.pull_request.base.sha }}`.
- `.github/workflows/PLAN-SPAR.yml:94` — `node base/scripts/collab/plan-spar.mjs --dir head --base-sha "$BASE_SHA" …`.

The CI log for run 39606554146 shows `BASE_SHA: 7b6425b032b33f92a6dce26310a41a8c98d095e9`. That commit **predates
vitana-platform #4202** (merge `b74135485c2f1db7211e9371f60fd8c32358a5df`), verified with
`git merge-base --is-ancestor b7413548… 7b6425b…` → exit 1 (not an ancestor), and `git show 7b6425b:scripts/collab/plan-spar.mjs`
contains no `parseSparRefs`/`spar_refs`. So the `plan-spar.mjs` that actually ran was the pre-#4202 version that never
reads `spar_refs:` from `handoff.md`; vitana-v1 was never folded into `extra_refs`; the partner was created with no
vitana-v1 ref and therefore had zero vitana-v1 (and zero vitana-platform companion) files it could cite with
`read_file`, producing `evidence_floor_not_met`.

The 2026-10-21T22:05Z re-spar assumed "PLAN-SPAR runs plan-spar.mjs from the PR base = `main`, which now includes
#4202". That is the error: the base checkout is `pull_request.base.sha` (the recorded base-branch commit the PR was
last synced against), **not** `main` HEAD. A declared `spar_refs:` only takes effect when the base commit that CI
checks out already contains `parseSparRefs` — i.e. when the PR's base is advanced to a post-#4202 commit.

## Fix applied

Merge current `origin/main` (`c74812569fd43b4c185b3fed26ca52f7e0244f12`, which has #4202 as an ancestor — verified
`git merge-base --is-ancestor b7413548… origin/main` → exit 0, and `git show origin/main:scripts/collab/plan-spar.mjs`
contains `export function parseSparRefs(fm)`) into this branch. That advances the PR's base/merge-base so the next
PLAN-SPAR run checks out a base containing the mechanism, reads `spar_refs: exafyltd/vitana-v1:
69d39ef344b578f1ff171e99c61295f51c4e1f50` from `handoff.md`, folds vitana-v1 into the session refs, and the partner
can run real `read_file`-cited premise checks against both repos.

`spar_refs:` is unchanged: vitana-v1 `origin/main` is still `69d39ef344b578f1ff171e99c61295f51c4e1f50` (re-fetched
2026-10-21), so every plan pin and `file:line` premise holds exactly as written.

No finding on the plan's substance was raised this round, so there is nothing in the plan to accept/reject/defer. The
R1-F1/F2/F3 answers in `responses-1.md` (mechanism merged in #4202; the prose "vitana-v1-ref session first" gate
dropped in favour of the code-enforced converged+policy-approved path; PR-GATE `ratchet-design` premises verified at
vitana-v1 69d39ef344) stand and are now checkable by the partner directly in the next round.

```json
[
  {
    "finding_id": "S6963-R1-partner-error",
    "disposition": "accepted",
    "rationale": "Not a plan finding: evidence_floor_not_met because the base checkout that ran plan-spar.mjs was 7b6425b (pre-#4202, no parseSparRefs), so spar_refs was never read and the partner had no vitana-v1 files to cite. Fixed by merging origin/main (c7481256, #4202 ancestor) into the branch so the next PLAN-SPAR run checks out a base with the mechanism and attaches vitana-v1. spar_refs SHA unchanged (vitana-v1 origin/main still 69d39ef344). Verified: PLAN-SPAR.yml:48-52/:90/:94 run the driver from pull_request.base.sha; merge-base --is-ancestor b7413548 7b6425b exit 1 (pre-#4202); merge-base --is-ancestor b7413548 origin/main exit 0 (#4202 present); 7b6425b:scripts/collab/plan-spar.mjs has no parseSparRefs, origin/main:scripts/collab/plan-spar.mjs has parseSparRefs.",
    "deferred_to": ""
  }
]
```
