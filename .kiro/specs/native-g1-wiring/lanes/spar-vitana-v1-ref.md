---
lane: spar-vitana-v1-ref
state: in-review
next_actor: claude
depends_on: []
executor: claude
reviewer_seat: claude
pr: https://github.com/exafyltd/vitana-platform/pull/4201
paths:
  - .github/workflows/PLAN-SPAR.yml
  - scripts/collab/plan-spar.mjs
  - scripts/collab/plan-spar.test.mjs
updated: 2026-10-19T02:30Z
---
# Give the sparring partner a vitana-v1 ref (R1-F1)

Plan: `.kiro/specs/native-g1-wiring/` — `plan.md` (plan block) is authoritative. **Governance-path lane
(`executor: claude`): `.github/workflows/**` and `scripts/collab/**`.**

**Why.** Native plans premise on code in **vitana-v1** (`apps/mobile/**`), but the sparring session was
created pinned only to `vitana-platform`, so the partner could not read or verify any native `file:line`
claim (sparring R1-F1/R1-F2 on `native-g1-wiring`).

**The fix — two files, no gateway change.** The gateway already accepts `extra_refs`
(`services/gateway/src/services/plan-sparring/plan-sparring-service.ts` validates each key against
`PLAN_SPARRING_REPOS`) and `github-tools.ts` already allowlists `exafyltd/vitana-v1`:
1. `.github/workflows/PLAN-SPAR.yml` resolves the vitana-v1 `main` SHA
   (`gh api repos/exafyltd/vitana-v1/commits/main --jq .sha`) and passes `--extra-ref-vitana-v1`
   (best-effort; a lookup failure forwards nothing).
2. `scripts/collab/plan-spar.mjs` forwards a valid 40-hex SHA as
   `extra_refs: { 'exafyltd/vitana-v1': <sha> }` in `client.create`, only when provided; platform-only
   plans are byte-for-byte unchanged.
3. `scripts/collab/plan-spar.test.mjs` proves `extra_refs` is forwarded when set, omitted when null/empty.

**Overlap with #4186.** `plan(sparring-floor-retry)` #4186's `floor-retry-code` lane also edits
`plan-spar.mjs`; this change is additive (one new arg + one guarded field) and rebases cleanly, but check
for overlap before merging.

**Acceptance.** A fresh native-plan sparring session shows `tool_log` with a successful
`read_file(repo: "exafyltd/vitana-v1", …)` (e.g. `apps/mobile/src/config/env.ts`); platform-only plans
unchanged; `node --test scripts/collab/plan-spar.test.mjs` 10/10.

## Log
### 2026-10-19T02:30Z · kiro-202610151913-51bd · ready → in-review
Implemented end to end (owner directive: run it all). PR #4201. Two files + a test; `node --check` clean,
plan-spar.test.mjs 10/10, `extra_refs` shape verified against the gateway validator. next_actor: claude
(governance-path lane). On merge, open a fresh native-g1-wiring session and confirm the vitana-v1 reads.
