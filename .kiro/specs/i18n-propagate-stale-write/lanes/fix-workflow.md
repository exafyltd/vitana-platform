---
lane: fix-workflow
state: ready
next_actor: claude
executor: claude
reviewer_seat: exafyltd
depends_on: []
paths:
  - .github/workflows/I18N-PROPAGATE.yml
  - .github/workflows/i18n-check.yml
  - scripts/i18n-propagate-apply.mjs
  - scripts/i18n-propagate-apply.test.mjs
updated: 2026-10-16T10:25Z
---
# fix-workflow — key-level merge in I18N-PROPAGATE's collect job

Repo: **exafyltd/vitana-v1** (paths above are vitana-v1 paths). Plan: `.kiro/specs/i18n-propagate-stale-write/plan.md`;
tasks 1–5 in `tasks.md`. `executor: claude` because the lane changes `.github/**` (governance path, collaboration §3a).
Reviewer: seat `exafyltd` (Kiro). The PR adds `docs/validation/<VTID>/` (sparring record copy, `scope.json`,
`acceptance.md`); no staging suite — the change deploys nothing.

## Log
### 2026-10-16T10:25Z · kiro-202610152203-0347 · created → ready
Drafted with the plan. next_actor: claude (after sparring + VTID).
