---
slug: collab-bom-tolerance
author: kiro
author_seat: exafyltd
executor: kiro
next_actor: kiro
state: approved
updated: 2026-11-02T11:22Z
sparring_record: .kiro/specs/collab-bom-tolerance/sparring/verdict.md
vtids: [VTID-05462]
---
# Handoff — collab-bom-tolerance
Eight `.kiro/specs/desktop-spotlight-finish/lanes/*.md` files on `origin/main` start with a UTF-8 BOM. The validator's
`parseFrontMatter` (`scripts/collab/queue.mjs:152-153`) anchors on `^---`, so an unchanged BOM lane file reports
`no front matter`, and every append-only records PR for those lanes fails Collab handoff (platform #4568-#4572). This
plan makes `parseFrontMatter` skip one leading U+FEFF, with a red-to-green test. `scripts/collab/queue.mjs` is a
protected gate file (§3a): the plan PR and the lane PR merge only on the owner's instruction naming this plan.
Plan: `plan.md`. Tasks: `tasks.md`.
Lanes:
- `bom-strip`: repo `exafyltd/vitana-platform`, executor kiro, seat exafy.
## Log
### 2026-11-01T23:15Z · kiro-exafyltd-202611012315-0b54 · drafted
Written for the owner backlog-cleanup task (workflow `wf_d226722607ecc20f`) from a read-only scan of vitana-platform
`origin/main` `c90b993fce`. Next: PLAN-SPAR spars this PR.

### 2026-11-02T11:22Z · ci-plan-spar · drafted → approved
Converged; approved by policy converged-auto-v1. 1 lane(s) got a VTID and are handed to Kiro.
