# VTID-04621 — CI log excerpts: fetch job logs with a media type GitHub accepts

Observed 2026-09-26 on staging: the first two live fix-mode children
(e8118eb9 on PR #3730, 489a1de2 on PR #3736) received
`[log unavailable] log fetch failed: GitHub 415 on /repos/.../actions/jobs/<id>/logs`
for every failing check, so the coding agent was told which check failed but
never what failed in it. Verified against the live API the same minute:
`Accept: text/plain` -> 415, `Accept: application/vnd.github+json` -> 302 to
the plain-text log.

## Acceptance criteria

AC-1: the default job-log fetch sends `Accept: application/vnd.github+json` and reads the redirected body as text, producing a real excerpt (mutation-checked: sending text/plain fails the test).
TEST: services/gateway/test/vtid-04621-ci-log-accept.test.ts

AC-2: excerpt selection and rendering are unchanged.
TEST: services/gateway/test/dev-autopilot-ci-logs.test.ts
