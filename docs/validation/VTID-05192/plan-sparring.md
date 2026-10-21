# VTID-05192 — Plan sparring record

- **Plan hash (sha256 of the text between the plan markers, first 16 hex):** `9224657b31fecdc0`
- **Change class:** standard · **Partner:** `plan-sparring-partner` (independent, read-only) · **Rounds:** 2
- **Verdict:** CONVERGED (round 2: F1–F5 all closed, no new findings)
- **Owner approval (Gate 1):** 2026-10-14, Claude Code session `session_01VfFmxfKqidAuisVgjFsiC6` — "yes, go ahead"
- **Repos:** `exafyltd/vitana-platform` and `exafyltd/vitana-v1` (one VTID, one PR per repo, identical record)

# Plan — Fixed roles in the Claude Code ↔ Kiro protocol: Claude Code controls, Kiro implements

<!-- plan:begin -->
## Problem
Owner decision 2026-10-14: *Claude Code is the controller — it plans, gets the plan sparred and approved, verifies the
implementation; Kiro does the coding. This must be a standing working principle in both repos so no session (Claude
or Kiro) has to be told again.*

VTID-05145 (merged 2026-10-13, `ba328fc4`) already set up the protocol: Git as the only channel, `.kiro/specs/<slug>/`
with `handoff.md` + `lanes/*.md`, claims via `scripts/collab/queue.mjs`, PR-GATE "Collab handoff" check, a Claude
Routine (`scripts/collab/routine-prompt.md`). It is **symmetric**: §7 "Either agent writes plans; the other executes;
the other verifies" (`.claude/rules/collaboration.md`). Gaps against the owner's decision:
1. No fixed roles — either agent may author or execute.
2. No limits on what the executor may do. Since 2026-10-12 Kiro Web has the same Supabase (`postgres`) and AWS
   (`kiro-agent-role` = mirror of `claude-staging-validation`) access as Claude Code (owner decision, this session),
   so a Kiro session can technically apply migrations, run DML, update ECS services or merge.
3. `collaboration.md` reaches Kiro only through `.kiro/steering/vitana-collaboration.md`, which is
   `inclusion: fileMatch` on `.kiro/specs/**` — a Kiro session that has not opened a spec file does not load it. The
   always-included `vitana-kiro-notes.md` has a VTID-05145 collaboration bullet (session id, queue, claim; plain-text
   pointer to `collaboration.md`) but nothing about roles or executor limits.
4. §8 assumes Kiro runs only in the IDE on the owner's machine; Kiro Web cloud sessions (app.kiro.dev, connected
   2026-10-12 with both repos) are not mentioned.

## Change (change class: standard — governance docs in both repos; no app code, routes, migrations, workflows, deploy)

### vitana-platform
1. `.claude/rules/collaboration.md`
   - §7 Roles: new first paragraph **"Default roles — fixed (owner decision 2026-10-14)"**: Claude Code is author,
     coordinator (`_plan` claim) and reviewer of every plan, and the only one who merges and sends Gate 1 / Gate 2.
     Kiro is the executor of lanes (`executor: kiro`). Kiro authors a plan only when the owner asks Kiro directly for
     one; it then goes through Claude Code sparring as today. Claude Code executes a lane only when the owner assigns
     it (`executor: claude` set by the owner's instruction) or for the protocol's own coordinator commits. The existing
     "Kiro authors → Claude executes" bullet is kept as that owner-requested exception; the "Claude authors → Kiro
     executes" bullet becomes the default flow.
   - New §7a **"What the executor never does"** (applies to Kiro; to Claude Code when it executes a lane): allocate a
     VTID, take a `_plan` claim or edit `handoff.md`, merge or approve a PR, dispatch a workflow, deploy, or write to a
     live system — no Supabase writes (`execute_sql` with INSERT/UPDATE/DELETE/DDL, `apply_migration`,
     `deploy_edge_function`, branch/project/secret tools) and no mutating AWS call (ECS/ELB/ECR/IAM/Secrets Manager
     writes), even though its credentials allow it. Reading for diagnosis is fine. A database change is a migration
     file in the lane's PR. Blocked → log entry + `next_actor: claude`, never a workaround.
   - §8: Kiro also runs as **Kiro Web** cloud sessions: the owner opens a session on `vitana-platform` at
     app.kiro.dev and types "continue"; Kiro clones `exafyltd/vitana-v1` next to it (the Kiro GitHub app covers both
     repos) so `queue.mjs --repo … --repo …` works as in the IDE. If the session cannot get the second checkout, it
     runs `queue.mjs --repo <available repo>` only, works lanes in that repo, and leaves cross-repo lanes alone.
2. `.kiro/steering/vitana-kiro-notes.md` (always included): **amend the existing VTID-05145 collaboration bullet**
   (keep its session-start text) by prepending, as **inline text** (no `#[[file:…]]` link — the kiro-steering guard
   rejects a `.claude/rules/*` link from an `inclusion: always` file, `guard.cjs:79`): "**Your role: implementer.**
   Claude Code plans, spars, coordinates, reviews and merges; you implement the lanes assigned to Kiro." followed by
   the full §7a list verbatim (never allocate a VTID, take `_plan` / edit `handoff.md`, merge or approve, dispatch a
   workflow, deploy, write to Supabase or make a mutating AWS call; DB change = migration file in the PR; blocked →
   log entry + `next_actor: claude`). This is the copy that reaches every Kiro session, whatever files it opens.
3. `CLAUDE.md` § CLAUDE CODE ↔ KIRO COLLABORATION: one added sentence — "Default roles (owner decision 2026-10-14):
   Claude Code plans, spars, coordinates, reviews, merges and sends both gates; Kiro implements lanes and never
   merges, deploys or writes to a live system. See `.claude/rules/collaboration.md` §7–§7a."
4. `scripts/collab/routine-prompt.md` step 5: "implement an approved lane" → only lanes with `executor: claude`;
   for `executor: kiro` lanes Claude reviews, never implements.

### vitana-v1
5. `.claude/rules/collaboration.md` — byte-identical copy of (1) (the file says it is identical in both repos).
6. `.kiro/steering/vitana-kiro-notes.md` — same amendment as (2) (the vitana-v1 bullet keeps its own path wording).
7. `CLAUDE.md` § CLAUDE CODE ↔ KIRO COLLABORATION — same sentence as (3).

Each PR carries `docs/validation/<VTID>/plan-sparring.md`. Platform PR first, then vitana-v1.

## Not in scope
- No technical enforcement of §7a. Kiro's credentials stay as the owner set them on 2026-10-12; the rule is
  behavioural, like Claude Code's own. Recorded residual: enforcement would be `kiro-readonly-role` + read-only
  Supabase, which the owner declined.
- No change to `queue.mjs` or the PR-GATE check; no new states or front-matter keys (`executor` already exists).
- No What's New entry (governance, not a member feature).

## Tests / verification
- Existing CI: PR-GATE `kiro-steering` guard (links resolve, always file links CLAUDE.md) and "Collab handoff"
  (`queue.mjs validate`) stay green in both repos.
- Local: `node scripts/ci/kiro-steering/guard.cjs .` in both repos; `diff` of the two `collaboration.md` files = empty.
- No deploy → no Gate 2; done when both PRs are merged with green checks.
<!-- plan:end -->

## Planner responses — round 1
- **F1 [blocker] — ACCEPTED.** No `#[[file:…]]` link in `vitana-kiro-notes.md`; the role summary and the full §7a list go
  in as inline text. Guard unchanged and stays green.
- **F2 [major] — ACCEPTED.** Premise corrected: the file already carries the VTID-05145 collaboration bullet; items 2/6
  now amend that bullet instead of adding a new one.
- **F3 [major] — ACCEPTED.** The full "never does" list is inline in the always-included file, so every Kiro session
  sees it regardless of which files it opens. `collaboration.md` keeps its `paths:`.
- **F4 [minor] — ACCEPTED.** Covered by the F2 rewrite.
- **F5 [minor] — ACCEPTED.** §8 text gets the single-repo fallback (work lanes in the available repo, leave cross-repo
  lanes).
- **Q2 — answered:** prepend the role summary + list to the existing bullet; keep its session-start text unchanged.

## Partner findings — round 1 (verdict: NOT CONVERGED)
- **F1 [blocker]** Adding `#[[file:.claude/rules/collaboration.md]]` to the always-included `vitana-kiro-notes.md` breaks
  the kiro-steering guard: `scripts/ci/kiro-steering/guard.cjs:79` requires a steering file that links a
  `.claude/rules/*.md` file to be `inclusion: fileMatch` (`guard.test.cjs:41-43` asserts the rejection). Suggestion:
  inline text instead of a link.
- **F2 [major]** Premise wrong: `vitana-kiro-notes.md:13-17` already carries a VTID-05145 collaboration bullet; the plan
  should amend it, not add a new bullet.
- **F3 [major]** The §7a list would not reach Kiro sessions that never open `.kiro/specs/**`
  (`vitana-collaboration.md:2-4` is `fileMatch`), while Kiro holds `postgres` and `kiro-agent-role` credentials.
  Suggestion: the list inline in the always-included file.
- **F4 [minor]** Same as F2 — describe the delta accurately.
- **F5 [minor]** Kiro Web cloning the second repo is an unverified capability; add a single-repo fallback.

## Partner disposition — round 2 (verdict: CONVERGED)
F1 closed (inline text, guard stays green) · F2 closed · F3 closed (full list in the always-included file) · F4 closed
(subsumed by F2) · F5 closed (single-repo fallback in §8). New findings: none.
