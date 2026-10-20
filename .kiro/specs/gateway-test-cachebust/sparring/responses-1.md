# Responses — round 1

```json
[
  {
    "finding_id": "R1-F1",
    "disposition": "rejected",
    "rationale": "kind \"existing\" is a recognised staging-verify kind: scripts/ci/staging-verify/lib.cjs:169 (case 'existing'), with tests in lib.test.cjs:61-64; merged suites use it, e.g. docs/validation/VTID-05209/staging-tests.json, VTID-04527, VTID-04600, VTID-04626. A test-only change has nothing new on staging to probe over HTTP, so the existing entry that runs the fixed file is the right suite. The plan block now cites the runner line."
  },
  {
    "finding_id": "R1-F2",
    "disposition": "accepted",
    "rationale": "Already task T2 in tasks.md; now stated in the plan block too: docs/validation/<VTID>/acceptance.md with AC- entries, which VALIDATOR-CHECK.yml:148 and :158 require, plus plan-sparring.md and scope.json."
  }
]
```
