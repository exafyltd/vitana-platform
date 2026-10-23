---
lane: manifests-05297
state: ready
next_actor: kiro
depends_on: [runner]
executor: kiro
seat: exafyltd
area: frontend
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
repos: [exafyltd/vitana-v1]
paths:
  - docs/validation/VTID-05297/staging-tests.json
  - docs/validation/VTID-*/**
updated: 2026-10-23T10:40Z
---
# VTID-05297 native Home suite: bundle with APP_PROFILE (vitana-v1, STAGING-VERIFY fix-forward)
Plan: `.kiro/specs/staging-verify-runner-fix/` — `tasks.md` section `<!-- lane: manifests-05297 -->`.

**Never** (collaboration §7a): no VTID allocation, no merge except §7b, no live write, no test against production.

## Log
### 2026-10-23T10:40Z · kiro-exafyltd-202610220818-5273 · created → ready
Fix-forward (driver step 7; a `done` lane is never reopened). STAGING-VERIFY community-app run 39870086198 on staging
`77cb11280` (contains VTID-05330 and both lanes): 31/32 passed; the only failure is VTID-05297
`npm run bundle` — "Error reading Expo config … app.config.ts" (APP_PROFILE not set). VTID-05297 (#1493, native Home)
merged after lane `manifests`, so its manifest lacks the `env` added there. Next: CI allocates the VTID; seat
`exafyltd` adds `env: {APP_PROFILE: development}` to that entry.
