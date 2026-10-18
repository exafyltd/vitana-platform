---
lane: spar-vitana-v1-ref
state: ready
next_actor: claude
depends_on: []
executor: claude
reviewer_seat: claude
paths:
  - .github/workflows/PLAN-SPAR.yml
updated: 2026-10-18T20:40Z
---
# Give the sparring partner a vitana-v1 ref (R1-F1)

Plan: `.kiro/specs/native-g1-wiring/` — `plan.md` (plan block) is authoritative. VTID: assigned by CI
after PLAN-SPAR converges. **This is a governance-path lane in `vitana-platform` (`executor: claude`): the
planner seat (kiro/exafyltd) cannot touch `.github/**` (collaboration §3a).**

**Why.** Every native plan in this program (`native-g1-wiring`, `native-wave2-*`, future Wave 2/3 plans)
premises on code in **vitana-v1** (`apps/mobile/**`), but PLAN-SPAR runs the sparring session pinned only
to `vitana-platform` (`PLAN-SPAR.yml` base checkout, `ref: pull_request.base.sha`). The partner therefore
cannot read or verify any native `file:line` claim, and (round 2 of this plan) correctly refuses to let a
native plan converge on premises the gate cannot check — collaboration §1 ("a result that is not pushed to
origin does not exist") plus CLAUDE.md rule 52 (verify premises against `file:line`).

**Goal.** Make the plan-sparring partner able to read `exafyltd/vitana-v1` at a pinned commit, for any
`plan(<slug>)` PR whose lanes declare vitana-v1 paths. Options for the implementer (Claude Code) to weigh:
1. Add a second pinned checkout of `exafyltd/vitana-v1` in `PLAN-SPAR.yml` and pass it to the gateway
   sparring call as an `extra_refs` entry (the create-session API already accepts `extra_refs` keyed by
   repo — `plans-spar.ts` / `plan-sparring-service.ts` validate against `PLAN_SPARRING_REPOS`, which
   already includes both repos). The partner's `read_file`/`search_code` tools already accept
   `repo: exafyltd/vitana-v1` (`github-tools.ts` `PLAN_SPARRING_REPOS`); the missing piece is the pinned
   ref in the session, not tool support.
2. Or resolve a vitana-v1 ref server-side when a plan's lanes name vitana-v1 paths.

**Acceptance.**
- A re-spar of `native-g1-wiring` (and `native-wave2-home-feed-news`) shows the partner's `tool_log`
  containing successful `read_file(repo: "exafyltd/vitana-v1", ...)` entries for the cited paths
  (e.g. `apps/mobile/src/config/env.ts`), i.e. the native `file:line` premises become partner-verifiable.
- No change to how platform-only plans spar.
- `docs/validation/<VTID>/{scope.json,staging-tests.json,plan-sparring.md}` committed at the
  vitana-platform repo root.

**Gating.** Until this lane merges and the native plans are re-sparred with the vitana-v1 ref live, no
implementation lane in this spec may move `approved→executing` — the plan block records this block.

**Never** (collaboration §7a): the lane is `executor: claude`; the planner/kiro seats never dispatch
workflows, deploy, or edit `.github/**`.

## Log
### 2026-10-18T20:40Z · kiro-202610151913-51bd · created → ready
Created in response to sparring R1-F1 (round 1) and its round-2 dispute: the deferred vitana-v1-ref fix is
now a durable tracked lane, not a prose note. next_actor: claude (governance path). Hand to Claude Code to
add the vitana-v1 ref to PLAN-SPAR.yml; this plan does not go approved→executing until it merges and the
native plans re-spar with the ref live.
