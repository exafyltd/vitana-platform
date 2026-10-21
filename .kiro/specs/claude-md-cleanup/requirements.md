# Requirements — claude-md-cleanup
Authoritative plan: `plan.md` (between the plan markers). This file adds acceptance criteria only.

## R1 — generic, stale and duplicated text is gone
WHEN a lane is done, THEN the platform `CLAUDE.md` no longer carries the rules listed in plan items A, B (incl.
IF–THEN 20 `git reset --hard`), F, the cutover/GCP history of E, the 35-line GCP banner (D), the 5-step visual
protocol (C), the mandatory codebase-intelligence workflow (K) or the duplicated sidebar rules (H); and the v1
`CLAUDE.md` no longer carries its copy of K or the long "Why no host is exempt" narrative.

## R2 — nothing that matters is weakened
Every MUST KEEP item (plan "MUST KEEP (L)") is still present in substance, and every token in the plan's verification
list is still found by grep in the file that carried it before. No new exemption is added (in particular no
trivial-change sparring class).

## R3 — no contradictions
- ALWAYS 2b, the VTID IF–THEN rules and §4.1 agree with rules 51–55: a VTID only after sparring + approval (owner
  Gate 1 or CI `converged-auto-v1`); Kiro's VTIDs come from CI PLAN-SPAR.
- No rule orders `git reset --hard` or a hand deploy outside CI.
- The screen rule agrees with v1's screen manifest / navigation registry / parity ledger process.
- The Collaboration paragraph and both steering files agree with `collaboration.md` §7–§7b.

## R4 — numbering
No Part 1 rule label appears twice. Every surviving rule keeps its number (or, for the generic NEVER and IF–THEN
rules, the prefixed label from the plan). Cross-references in lane paths resolve; references outside lane paths are
listed in the PR body.

## R5 — size
Platform `CLAUDE.md` ends roughly 400–550 lines (from 1021); v1 `CLAUDE.md` roughly 450–480 (from 574). Line counts
before/after are in `commands.log`.

## R6 — scope and process
Each lane PR changes only its `paths` plus its own `docs/validation/<VTID>/`. `.claude/CLAUDE.md` is untouched.
`queue.mjs validate` passes. The lane PRs are not merged by Kiro (protected gate file, owner review).
