# Responses to sparring round 1 (session 2)
```json
[
  {
    "finding_id": "R1-F1",
    "disposition": "accepted",
    "rationale": "Verified: docs/validation/VTID-05148/acceptance.md:13 still names app.js?v=20261120-vtid-05148 as CURL_PROOF prose, and the VTID-04696 test reads only docs/validation/*/staging-tests.json (vtid-04696-staging-checks-follow-asset-bumps.test.ts:36-38), so no gate reads it. The B5 grep (git grep -n for 20261120-vtid-05148 over services/gateway/test and docs/validation/*/staging-tests.json) already excludes that file, but the plan's wording ('no positive toContain/suite pin remains') did not say so. plan.md 'The app.js cache-key pin and its other places' now states the grep scope exactly (Jest toContain assertions under services/gateway/test and staging-tests.json suite pins only) and names acceptance.md:13 as a known, benign, ungated historical leftover that stays unedited (it records what staging served for VTID-05148). tasks.md B5 and design.md 'Only the test pin changes' carry the same scope note.",
    "deferred_to": null
  },
  {
    "finding_id": "R1-F2",
    "disposition": "accepted",
    "rationale": "Verified: check-pr returns before loadManifest/validateManifest when no deploy path is touched (scripts/ci/staging-verify/run.mjs:469-472), and the VTID-04696 test only matches asset?v= pins against index.html (vtid-04696-staging-checks-follow-asset-bumps.test.ts:35-46), so Lane A's record suite's shape is never gated. The 'held to the same validity' sentence is replaced in plan.md (evidence pack section) and design.md with an accurate statement, and suggestion (b) is taken: new task A6 runs lib.validateManifest (scripts/ci/staging-verify/lib.cjs:187, exported at :722) by hand on both docs/validation/VTID-05082/staging-tests.json and the lane's own suite, with service 'gateway' and each file's own vtid, and records the result in commands.log/outputs/. Lane A acceptance and plan.md Verification require it; it is described as a local check, not a CI gate. A dry run on the current VTID-05082 manifest returns {ok: true, errors: []}.",
    "deferred_to": null
  }
]
```
