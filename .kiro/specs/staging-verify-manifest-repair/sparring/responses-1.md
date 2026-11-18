# Responses to round 1

```json
[
  {"finding_id": "R1-F1", "disposition": "accepted", "rationale": "scripts/ci/staging-verify/workflow.test.cjs exists on origin/main (listed next to lib.test.cjs) and is only RUN by the lane, never modified; the lane's exact files stay as listed. The plan now says so in section 4 and in the lane's task T4."},
  {"finding_id": "R1-F2", "disposition": "accepted", "rationale": "drift-guard gets check 5: every key of an http probe in a gateway/community-app manifest must be in a closed allowlist (kind, name, target, method, path, expect_status, expect_content_type, expect_json, expect_json_in, expect_body_contains, rejected_probe, reason). I read every http probe of every such manifest on origin/main: the union of keys is exactly that set (883 probes), so the guard is green on the head and a typo such as expect_json_inn fails in CI. validateHttpTest in lib.cjs is not changed (a closed key set there would reject manifests of other repos); the guard test is the place."}
]
```
