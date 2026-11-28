---
lane: lane-pr-artifacts
state: ready
next_actor: claude
executor: claude
depends_on: [command-hub-lane-guard]
repos: [exafyltd/vitana-platform]
paths:
  - scripts/collab/lane-pr-artifacts.mjs
  - scripts/collab/lane-pr-artifacts.test.mjs
updated: 2026-11-17T15:10Z
---
# Lane — lane-pr-artifacts

Goal (plan §2 Lane C): after CI allocates a lane VTID, write the PR title, the branch key and
`docs/validation/<VTID>/{scope.json,acceptance.md,staging-tests.json}` from the lane file. Idempotent: a lane that
already has a `vtid` reuses it; an existing file is not rewritten with a different VTID. Acceptance: plan §4 Lane C.
