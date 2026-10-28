# VTID-05340 — Kiro Web vs Claude Code parity: baseline and with the kit

Representative task: this plan itself, a governance-path lane taken through the whole pipeline (plan PR → PLAN-SPAR →
CI VTID → lane → reviewer agent → §7b merge) in one Kiro Web session (`kiro-exafy-202610261526-5cd7`). Sources: local
clock for session steps, GitHub timestamps for pipeline steps. **No Claude Code run of the same task exists, so Claude
Code parity is unverified.** The numbers compare this session before and after the kit.

## Session readiness

| | Baseline (no kit, 15:25Z) | With the kit |
|---|---|---|
| Rules in context | none auto-loaded; ~3,000 lines read by hand | 14 workspace steering files injected every turn (`kiro-web-steering`, VTID-05339); `.claude/CLAUDE.md` truncated by Kiro |
| Code intelligence | install failed (`~/.local` read-only); 9 min 42 s to a ready index with manual probing | `setup`: venv + seeded index, cold 178 s, in the background |
| Gateway / v1 deps | missing | `npm ci` 5 s / 12 s, in `setup` |
| Hooks | none (Claude Code hooks never run here) | guard + mark-dirty, verified to execute and block |
| Readiness check | none | `status --check` exit 0 |
| Commands to get ready | ~25 manual tool calls | 3 (`kiro-web-steering.mjs`, `setup`, `status`) |

## Fast feedback (before CI)

| Check | Baseline | With the kit |
|---|---|---|
| Gateway typecheck | only in CI | at `git commit` after a gateway edit; blocked a seeded TS2322; warm 7 s |
| Governance preflight | manual (`driver.md:43`), easy to skip | before every `kiro/*` push, cached per head, 10-12 s; blocked an illegal lane transition before git ran |
| Waiting for CI | ad-hoc `gh api` polling | `wait`: returns on completion with the failed log tail |

## Pipeline run (GitHub timestamps, 2026-10-26)

| Step | Time |
|---|---|
| plan PR #4380 opened | 15:45:29Z |
| session 1 round 1 | escalated 15:50Z, partner `evidence_floor_not_met`, no findings |
| re-plan pushed (preflight via guard) | 16:00:59Z |
| session 2 round 1 → answers pushed | 16:06Z → 16:08Z (3 findings: 1 rejected with file:line, 2 accepted) |
| converged, policy approval | 16:11:27Z |
| VTID-05340 allocated (CI) | 16:14:49Z |
| plan PR merged (§7b) | 16:30:24Z |
| lane claimed | 16:19:10Z |
| lane PR / accept / merge | see `timings.json` (closing record) |

## Failures and interventions

- Preventable errors that reached CI: **0**. Collab handoff was red on every plan head. That is the known
  governance-artifact false positive: `queue.mjs:595` counts `ci-plan-spar` as a second `_plan` session. The sibling
  plan #4378 showed the same. §7b handled it at merge.
- Caught locally before CI: 1 real bug in this lane (workspace resolved from a worktree, found by the K5 run, fixed with a test), plus the
  two seeded guard demonstrations.
- CI fix-forward cycles: plan 0; lane: see the PR.
- Sparring: 1 partner-side escalation, which cost one re-plan (~11 min). 1 rejected finding was acknowledged by the
  partner.
- Owner interventions after the task was given: **0**.

## Still not at parity

See `docs/kiro-web-parity/README.md`, "Still not at Claude Code parity": no MCP, typecheck at commit instead of after
each edit, no SessionStart trigger, re-install on a fresh sandbox, sequential writing steps, unreadable
`CLAUDE_AVAILABLE`, and no direct comparison.
