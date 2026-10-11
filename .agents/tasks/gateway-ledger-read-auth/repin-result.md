# VTID-05063 repin result

Repinned HTML-path probes: expect_body_contains `app.js?v=20261109-vtid-05006` -> `app.js?v=20261110-vtid-05063` (14 probes, 13 files).

Files under docs/validation/ in the worktree (probe count):
- VTID-04779/staging-tests.json (1, /command-hub/voice/test-bench/)
- VTID-04836/staging-tests.json (1)
- VTID-04869/staging-tests.json (1)
- VTID-04876/staging-tests.json (1)
- VTID-04885/staging-tests.json (1)
- VTID-04886/staging-tests.json (1)
- VTID-04887/staging-tests.json (2, /command-hub/ and /command-hub/overview/live-metrics/)
- VTID-04975/staging-tests.json (1)
- VTID-04984/staging-tests.json (1)
- VTID-04999/staging-tests.json (1)
- VTID-05003/staging-tests.json (1)
- VTID-05004/staging-tests.json (1)
- VTID-05006/staging-tests.json (1)

Also changed: VTID-05063/scope.json (`files` renamed to `paths`, `"kind":"feature"` added after vtid, `docs/validation/*/staging-tests.json` appended).

Untouched on purpose: probes whose path is /command-hub/app.js?v=20261109-vtid-05006 or /command-hub/styles.css?v=20261109-vtid-05006 (static handler ignores the query string).

Final greps (docs/validation/**/staging-tests.json):
- `expect_body_contains.*20261109-vtid-05006`: 0 matches
- HTML-path probe line containing the old string: 0 matches
- old string on any line without a "path" key: 0 matches

Remaining occurrences of the old string are only in `path` values of app.js/styles.css probes.
No shell was used, so JSON validity was not machine-parsed; edits were same-length-style string swaps inside existing values.
