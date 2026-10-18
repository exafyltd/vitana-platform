---
lane: spar-vitana-v1-ref
state: ready
next_actor: claude
depends_on: []
executor: claude
reviewer_seat: claude
paths:
  - .github/workflows/PLAN-SPAR.yml
  - scripts/collab/plan-spar.mjs
updated: 2026-10-18T21:30Z
---
# Give the sparring partner a vitana-v1 ref (R1-F1)

Plan: `.kiro/specs/native-g1-wiring/` — `plan.md` (plan block) is authoritative. VTID: assigned by CI
after PLAN-SPAR converges. **This is a governance-path lane in `vitana-platform` (`executor: claude`): the
planner seat (kiro/exafyltd) cannot touch `.github/**` or `scripts/collab/**` (collaboration §3a).**

**Why.** Every native plan in this program (`native-g1-wiring`, `native-wave2-*`, future Wave 2/3 plans)
premises on code in **vitana-v1** (`apps/mobile/**`), but the sparring session is created pinned only to
`vitana-platform`, so the partner cannot read or verify any native `file:line` claim. Round 2 of this plan
correctly refused to converge native premises the gate cannot check (collaboration §1; CLAUDE.md rule 52).

**The fix is exactly two governance files — no gateway change.** The gateway already supports this:
`createSparringSession` accepts `extra_refs` and merges them into the pinned refs
(`services/gateway/src/services/plan-sparring/plan-sparring-service.ts` ~L92–116 and ~L266), and
`github-tools.ts` already lists `exafyltd/vitana-v1` in `PLAN_SPARRING_REPOS` and refuses only a repo with
no pinned ref (~L141). So:
1. `scripts/collab/plan-spar.mjs` — in the `client.create` call, send
   `extra_refs: { 'exafyltd/vitana-v1': <vitana-v1 main SHA> }`.
2. `.github/workflows/PLAN-SPAR.yml` — resolve that SHA
   (`gh api repos/exafyltd/vitana-v1/commits/main --jq .sha`) and pass it into the step that invokes
   `plan-spar.mjs`.

**Coordinate with `plan(sparring-floor-retry)` #4186.** That plan's `floor-retry-code` lane
(`executor: claude`) also edits `scripts/collab/plan-spar.mjs`. To avoid a conflict, both lanes should land
in **one Claude Code session / one PR**.

**Acceptance.**
- `scripts/collab/plan-spar.mjs` sends `extra_refs: { 'exafyltd/vitana-v1': <sha> }`; `PLAN-SPAR.yml`
  resolves `<sha>` from `repos/exafyltd/vitana-v1/commits/main` and passes it in.
- A **new** sparring session for `native-g1-wiring` (and `native-wave2-home-feed-news`) shows the partner's
  `tool_log` with successful `read_file(repo: "exafyltd/vitana-v1", …)` for cited paths
  (e.g. `apps/mobile/src/config/env.ts`), i.e. native `file:line` premises become partner-verifiable.
- No change to how platform-only plans spar.
- `docs/validation/<VTID>/{scope.json,staging-tests.json,plan-sparring.md}` committed at the
  vitana-platform repo root.

**Refs are pinned at session-creation (important).** The current native-g1-wiring session
(`2d48c240…`) was created before this fix and can **never** read vitana-v1, even after the fix merges. So:
if R1-F1 stays disputed, this session escalates on R1-F1 alone; then, once this lane merges, the planner
changes the plan text and pushes, which opens a **new** session with vitana-v1 readable. That next session
is the last one for this plan.

**Gating.** Until this lane merges and the native plans re-spar (new session) with the vitana-v1 ref live,
no implementation lane in this spec moves `approved→executing` — the plan block records this block.

**Never** (collaboration §7a): the lane is `executor: claude`; the planner/kiro seats never dispatch
workflows, deploy, or edit `.github/**` / `scripts/collab/**`.

## Log
### 2026-10-18T20:40Z · kiro-202610151913-51bd · created → ready
Created in response to sparring R1-F1: the deferred vitana-v1-ref fix is a durable tracked lane, not a
prose note. next_actor: claude (governance path).
### 2026-10-18T21:30Z · kiro-202610151913-51bd · ready → ready
Narrowed to the exact fix (owner guidance): two files only — `plan-spar.mjs` sends
`extra_refs: { 'exafyltd/vitana-v1': <sha> }`, `PLAN-SPAR.yml` resolves the SHA; no gateway change.
Added `scripts/collab/plan-spar.mjs` to `paths`. Flagged the `plan-spar.mjs` overlap with #4186's
`floor-retry-code` lane — both must land in one Claude Code PR. Noted that refs pin at session creation,
so the fix needs a fresh session to take effect.
