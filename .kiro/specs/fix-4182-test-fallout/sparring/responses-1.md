# Responses to sparring round 1
```json
[
  {
    "finding_id": "R1-F1",
    "disposition": "accepted",
    "rationale": "Verified, and stronger than stated: STAGING-VERIFY.yml checks the target tree out at the deployed commit (ref: ${{ env.SHA }}), not main, and run.mjs:202 loadManifest reads from that tree. docs/validation/** is not a deploy path (lib.cjs:41, touchesService :102), AWS-STAGE-DEPLOY-GATEWAY.yml only triggers on services/gateway/** and itself, and planRange skips non-service commits (lib.cjs:279). So Lane A's merge deploys nothing, check-pr skips it and its VTID is never range-verified. The plan now has a section 'How Lane A's fix gets verified': Lane A is docs-only with no Gate 2 of its own, and the plan no longer claims its own commit is range-verified. The fix is proven by the next gateway deploy that contains it. Lane B (services/gateway/test/**) is a deploy path, so Lane A merges first and Lane B second (new task B4: Lane B opens its PR only after Lane A has merged); the STAGING-VERIFY run for Lane B's merge commit runs the corrected VTID-05082 suite and is the evidence for both lanes. If Lane B ends empty (B3, #4207 first), the next gateway-deploying merge or the nightly full run on the deployed commit proves it, recorded in Lane A's log. Updated plan.md (problem A.5, new section, Change heading, Verification), design.md (Decisions, Verification), tasks.md (Lane A acceptance, new B4). The lane files point at tasks.md for their steps, so B4 binds Lane B.",
    "deferred_to": null
  },
  {
    "finding_id": "R1-F2",
    "disposition": "rejected",
    "rationale": "The premise that svg-preview.js is not yet on staging is wrong. STAGING-VERIFY targets staging only, and staging already serves 05082: the last gateway run 39456004226 verified commit 3063c954, which contains 80e2b3553, and a read-only GET of https://preview-aws-gateway.vitanaland.com/command-hub/svg-preview.js?v=20261121-vtid-05082 (re-checked today) returns 200 with sanitizeSvgMarkup. index.html:29 on main loads it. Production being at 4e0e7d1f only means 05082 stays in the production..staging range, which is why the suite runs; it does not affect whether the corrected test passes on staging. The Lane A manual GET therefore reflects current staging, not a hypothetical post-deploy state. The remaining real dependency (the corrected manifest needs a deployed commit that contains it) is handled under R1-F1 by the A-then-B merge order, and the plan now states the staging evidence explicitly in the new section.",
    "deferred_to": null
  }
]
```
