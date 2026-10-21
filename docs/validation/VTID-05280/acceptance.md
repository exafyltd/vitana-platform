# Acceptance — VTID-05280 (claude-md-cleanup/rules-trim)

Docs-only change to `CLAUDE.md`, `.kiro/steering/vitana-kiro-notes.md`, `.kiro/steering/vitana-load-project-rules.md`.
Deploys nothing: no `staging-tests.json`, no STAGING-VERIFY, no Gate 2. All commands run from the repository root and
are read-only. Plan: `.kiro/specs/claude-md-cleanup/plan.md` (lane `rules-trim`), tasks.md acceptance.

AC-1: Every MUST-KEEP token from the plan's Verification list is still in `CLAUDE.md` (counts on origin/main vs
branch: `outputs/must-keep-check.txt`, 76 tokens incl. the 22 required ones, 0 missing).
TEST: node docs/validation/VTID-05280/check.mjs tokens  # => PASS 22/22 tokens present

AC-2: No Part 1 label is used twice within a section (origin/main had collisions at 16–31).
TEST: node docs/validation/VTID-05280/check.mjs labels  # => PASS no Part 1 label used twice within a section

AC-3: Line counts after the change (plan target "roughly 400–550"; 612 — see Decisions in the PR body).
TEST: node docs/validation/VTID-05280/check.mjs lines  # => CLAUDE.md 612, vitana-kiro-notes.md 19, vitana-load-project-rules.md 26

AC-4: Every ALWAYS/NEVER/IF–THEN label cited in a loaded rules file (`.claude/rules/**`, `.kiro/steering/**`)
resolves to a kept label, the `AI-n` alias or the retired-number index (full sweep: `outputs/xref-sweep.md`).
TEST: node docs/validation/VTID-05280/check.mjs xref  # => PASS every label cited in .claude/rules/** and .kiro/steering/** resolves

AC-5: IF–THEN 20 (`git reset --hard origin/main` before deploying) is deleted, not reworded.
TEST: git grep -n "git reset --hard" -- CLAUDE.md  # => exactly one hit, the retired-number index row "IF–THEN 20 (… before deploy) | deleted"

AC-6: No trivial-change sparring exemption is added; the gate states there is none.
TEST: git grep -c "There is no" -- CLAUDE.md  # => CLAUDE.md:1 ("There is no trivial-change exemption.")

AC-7: Codebase intelligence is recommended, not mandatory (plan K, weakened on purpose, `outputs/diff-review.md`).
TEST: git grep -c "Mandatory Codebase Intelligence" -- CLAUDE.md  # => no output (0 matches)

AC-8: CI/CD section states current behaviour, without the 8 Jun 2026 time-gated cutover framing.
TEST: git grep -c "8 Jun 2026" -- CLAUDE.md  # => no output (0 matches)

AC-9: The diff touches only the lane paths and its own evidence; `.claude/CLAUDE.md` is unchanged.
TEST: git diff --name-only origin/main...HEAD  # => only CLAUDE.md, .kiro/steering/vitana-kiro-notes.md, .kiro/steering/vitana-load-project-rules.md, docs/validation/VTID-05280/**
TEST: git diff --quiet origin/main...HEAD -- .claude/CLAUDE.md  # => exit 0

AC-10: The Kiro steering guard passes on the branch; collab validation fails only with the known false positive
while the plan PR #4232 is unmerged (the lane file `.kiro/specs/claude-md-cleanup/lanes/rules-trim.md` exists only on
that PR; collaboration.md §7b), and passes once #4232 is on main.
TEST: node scripts/ci/kiro-steering/guard.cjs .  # => kiro-steering: OK
TEST: node scripts/collab/queue.mjs validate --base origin/main --head HEAD  # => exit 1 before #4232 merges, only "lanes/rules-trim.md does not exist"; exit 0 after

AC-11: The steering files no longer carry the stale "about 1,000 lines" claim, and the session-start steps appear once
(in `vitana-load-project-rules.md` step 4).
TEST: git grep -c "1,000 lines" -- .kiro/steering  # => no output (0 matches)
TEST: git grep -c "session-id --agent kiro" -- .kiro/steering  # => .kiro/steering/vitana-load-project-rules.md:1
