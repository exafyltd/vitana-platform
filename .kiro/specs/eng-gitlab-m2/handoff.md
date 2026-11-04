---
slug: eng-gitlab-m2
author: kiro
author_seat: exafy
executor: kiro
next_actor: kiro
state: drafted
updated: 2026-11-04T19:27Z
---
# Handoff — eng-gitlab-m2
Milestone 2 of the self-hosted GitLab CI (program `engineering-platform`). Plan: `plan.md`.

## Log

### 2026-11-03T19:40Z · kiro-exafy-202611021438-cff7 · drafted
Owner, 2026-11-03: continue with the own plan, and "we only pay for aws instances. no license fees to GitLab or others".
Premium is dropped: decision D2 is replaced by the Free-tier rule in plan §2. Pushed as a `plan(` PR for CI PLAN-SPAR.
No code before VTIDs.

### 2026-11-04T18:59Z · kiro-exafy-202611021438-cff7 · fix
PLAN-SPAR stopped at once (exit 2): `spar_refs` listed the plan's own repo, which is pinned by the PR base commit and is not allowed there. M2 touches only vitana-platform, so the key is removed. No other change.

### 2026-11-04T19:27Z · kiro-exafy-202611021438-cff7 · sparring round 1 answered
Round 1 (session `af19bcd5…`) returned three findings, all accepted: no `cicd.*` topic is reused and the five
`scm.gitlab.*` topics are listed (the lifecycle mapper is untouched); the route maps the `webhook-*` headers itself; the
GitLab job-status table for `checksVerdict` is in plan §3.4. Answers in `sparring/responses-1.md`.
