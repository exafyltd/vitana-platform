---
change_class: standard
---
# plan(claude-migration-lanes): Claude Code builds migration lanes again, and the owner can move four lanes to it

Author: Claude Code, session `session_01Cp885Gw1CMmPDvDVHc7kw8`, lane-less planner. Premises: vitana-platform `origin/main` at the base commit of this PR (0f45367bb6, the base recorded on the PR).
Owner, 2026-11-05: *"we need serious contribution and if needed we change the rules"*; lanes `verify-on-gitlab`, `github-bridge`, `merge-queue`, `pipelines`; rule scope "lift Claude retirement in general". Owner approval of this plan recorded in `handoff.md`.

<!-- plan:begin -->
## 1. Goal
Let Claude Code build lanes marked `executor: claude` in every plan, and let the owner move four engineering-platform lanes from seat `exafy` to Claude Code, so that the GitLab migration (`agentic-delivery`) has two builders in parallel. Unchanged: the builder never accepts its own lane; production is only reached by PUBLISH or the owner's command (§7c); protected gate files never merge on a reviewer-agent accept alone.

## 2. Premises (checked on the base commit, round 1 findings included)
- P1. `.claude/rules/collaboration.md` says Claude Code is retired from lane review (`:140`, `:271`) and routes `executor: claude` work to the exceptions seat while Claude is unavailable (`:195`, `:218`, `:228`). This is prose, not code.
- P2. `scripts/collab/queue.mjs:240-241` already accepts an `executor: claude` lane that reaches a governance path. A Claude builder can change governance files with no code change.
- P3. `scripts/collab/queue.mjs:1000-1018` (scopeCheck): a trusted lane-admin lane (`executor: kiro`, reviewer agent, `lane_admin: true`, paths covering the target lane file, read from the trusted revision) may change all four permission fields `executor`, `seat`, `reviewer_seat`, `paths` of the target lane. The "seat and paths only" limit is prose in `collaboration.md` §7a, not code. Round 1 F2 confirmed this.
- P4. `scripts/collab/queue.mjs:228-229`: a lane whose `reviewer_seat` is a reviewer agent must have `executor: kiro`. So a Claude lane cannot name the reviewer agent. The four target lanes name it today, so reassigning them requires changing `reviewer_seat` as well (a permission field, allowed by P3).
- P5. The four target lanes in `.kiro/specs/agentic-delivery/lanes/`: `verify-on-gitlab`, `merge-queue` and `pipelines` are `ready`, `executor: kiro`, `seat: exafy` on `origin/main`. `github-bridge` is `in-review` (open PR, accepted on head `4b59a16f`), so it is not reassigned unless it is `ready` and unclaimed when the lane runs.
- P6. The "Claude unavailable" rule (`collaboration.md` §7): unavailable when the repository variable `CLAUDE_AVAILABLE` is `false`, or when no `Collab-Session: session_…` commit lands on `main` or an open PR head in 4 h. A Claude builder commits at least every 4 h.
- P7. `CLAUDE.md` still says "Claude Code is retired". It is a protected gate file (`scripts/collab/protected-gate-files.json`), so this plan does not touch it.
- P8. Round 1 F1 (executor-switch declares a reviewer agent) is not a fact about this plan's head: the lane has `reviewer: owner` and no `reviewer_seat`. The real issue it points at is P4, handled in §3.

## 3. The change, lane by lane
- **`reinstate-rules`** (executor kiro, seat exafy, reviewer agent). Remove the retirement wording of `collaboration.md` (P1) and state that Claude Code builds `executor: claude` lanes in any plan. Also update the lane-administration prose in `collaboration.md` §7a (lines 251–253) to say a lane-admin lane may change `executor` and `reviewer_seat` on a target lane, as the code already allows (round 2 R2-F1). Governance path, not protected: a Kiro builder with the reviewer-agent accept (`collaboration.md` §3a). Touches no `queue.mjs`.
- **`reassign-migration`** (executor kiro, seat exafy, `lane_admin: true`, reviewer agent; `depends_on: [reinstate-rules]`). For each of `verify-on-gitlab`, `merge-queue`, `pipelines` (and `github-bridge` only if it is `ready` and unclaimed at the time the lane runs), set `executor: claude` and `reviewer_seat: exafyltd` (the exceptions seat, a Kiro account, independent of the Claude builder; P4 forbids the reviewer agent here). Its `paths` are only the target lane files. Plan §5 item 1 is the owner decision on the reviewer seat.
- **`executor-switch` is withdrawn** (round 1 F2): the code already allows the reassignment (P3), so no protected file changes. The owner approved a protected change in this plan; withdrawing it reduces the scope and needs no protected approval. Owner may object.

## 4. Test plan
- `node scripts/collab/queue.mjs validate --base origin/main --head <sha>` passes on this plan and on each lane PR.
- The reassignment is checked by `scripts/collab/queue.test.mjs` cases that already exist for `lane_admin`; no new code.
- Red before, green after, recorded in `docs/validation/<VTID>/` per lane.
- No test touches production; no lane runs against AWS, Supabase or GitHub write APIs.

## 5. Owner decisions this plan needs
1. Who reviews Claude-built lanes. The validator (P4) forbids the reviewer agent on them. The plan uses the exceptions seat `exafyltd`. Alternative: a code change to allow the reviewer agent on Claude lanes, which is protected and would need a new named approval.
2. Withdrawal of `executor-switch` (§3) is the planner's conservative choice; the owner may reinstate it if they want the protected change anyway.
3. `CLAUDE.md` wording stays until the owner names a separate plan (P7).

## 6. Risks
- R1 A Claude builder that stops committing for 4 h is treated as unavailable, and its lanes go to the exceptions seat. Mitigation: commit at each step; the lane log records each.
- R2 Two builders on the same program can collide on shared files. Mitigation: the four lanes move whole, never split; their declared paths are disjoint (`pipelines` owns `config/delivery/**` and the CI templates, `merge-queue` owns `scripts/eng/gitlab-land*.mjs`), and neither lane file declares a `depends_on` on the other (round 3 R3-F1: the earlier ordering claim was wrong).
- R3 Changing `reviewer_seat` to a Kiro seat means the Claude-built lanes are reviewed by a Kiro session, not by the reviewer agent. This is weaker independence than the agent. Mitigation: decision §5 item 1, and the reviewer seat is never the builder's.
<!-- plan:end -->

## Late lanes (added after convergence; outside the sparred plan text)
- `reinstate-admin` (executor kiro, seat exafy, `lane_admin: true`, reviewer agent; paths: `reinstate-rules.md` only). Owner option 1, 2026-11-05: reassigns VTID-05565 (`reinstate-rules`) from `executor: kiro` to `executor: claude` and reviewer seat `exafyltd`, because the code only allows a lane's executor to change through a trusted lane-admin lane. It adds no rule text and no code. Its VTID is allocated by CI PLAN-SPAR on this PR (late-lane path, as for `reseat` and `gitlab-verify`).
