# Plan A — Kiro IDE follows the same standing rules as Claude Code (steering files)

<!-- plan:begin -->
## Problem
The owner wants to build in Kiro IDE on both repos. Kiro IDE reads its rules from `.kiro/steering/*.md`, not from
`CLAUDE.md` / `.claude/rules/`. Neither repo has a `.kiro/` directory (verified: `ls vitana-platform/.kiro
vitana-v1/.kiro` → not found). A Kiro IDE session today would not see the Plan Sparring Gate, the two owner gates,
"never test against production", "never write as the test account", Claude-via-Bedrock only, the i18n rules, etc.

## Change (change class: standard — docs/config plus one PR-GATE.yml step per repo; no app code, no routes, no deploy)
In each repo add `.kiro/steering/`:
1. `vitana-standing-rules.md` — front matter `inclusion: always`. Body is a short header plus Kiro file references
   (`#[[file:CLAUDE.md]]` and `#[[file:.claude/CLAUDE.md]]`, in both repos) so Kiro loads the live
   CLAUDE.md text instead of a copy: no second source of truth, nothing to drift.
2. `vitana-backend.md` / `vitana-infrastructure.md` (vitana-platform) and `vitana-frontend.md` /
   `vitana-infrastructure.md` (vitana-v1) — `inclusion: fileMatch` with the same path globs the matching
   `.claude/rules/*.md` file declares in its own `paths:` front matter, each body a `#[[file:.claude/rules/<x>.md]]`
   reference. Same scoping as Claude Code.
3. `vitana-kiro-notes.md` — `inclusion: always`, a few lines only: Kiro IDE has no Claude Code skills, hooks or
   subagents, so (a) plan sparring is done through the Command Hub Operator / plan-sparring gateway tier or a Claude
   Code session, never skipped; (b) the PreToolUse sparring hook and SessionStart memory-pack hook do not run in
   Kiro — run `scripts/dev/resume-vtid.sh` (Plan B) by hand to load context.
4. A guard `scripts/ci/kiro-steering-guard.cjs` (both repos) with its own `node --test` self-test, run as a step in
   each repo's existing `PR-GATE.yml`: every `.claude/rules/*.md` file has a steering file whose fileMatch globs equal its `paths:`, and every
   `#[[file:…]]` reference points at a file that exists. Adding a rules file without its steering twin fails CI.

5. `.kiro/` added to `.dockerignore` (gateway; vitana-v1 if it has one) so it never enters an image.

## Premise (verified 2026-10-10 against kiro.dev/docs/steering)
`.kiro/steering/`, `inclusion: always|fileMatch|manual|auto`, `fileMatchPattern` string or array,
`#[[file:<relative_file_name>]]` links live workspace files and leaves a visible marker when unresolved. Kiro also
auto-includes `AGENTS.md` (both repos have the Codex repo-scope rule — consistent). Kiro CLI V1/V2 skip `fileMatch`
files, so the `always` file carries the rules; the Operator's Kiro CLI engine reads the same directory in its
worktree. Trade-off recorded in `vitana-kiro-notes.md`: the always-on load equals Claude Code's (CLAUDE.md, ~1k lines).

## Out of scope
Changing any rule text. Kiro hooks. Any model choice (Plan B).

## Tests
- Guard test above, in both repos.
- No deploy: docs/config only → no Gate 2; done when merged with green checks.
<!-- plan:end -->

## Planner responses — round 1
- **F1 [major] — ACCEPTED.** The guard is a standalone script `scripts/ci/kiro-steering-guard.cjs` (both repos), run as
  a step in each repo's existing `PR-GATE.yml` (runs on every PR; verified both repos have it), plus a Jest/Vitest-free
  self-test via `node --test scripts/ci/kiro-steering-guard.test.cjs` in the same step. Not in TEST-SUITE.
- **F2 [major] — ACCEPTED, premise verified now.** kiro.dev/docs/steering (fetched 2026-10-10): location
  `.kiro/steering/`; front matter `inclusion: always|fileMatch|manual|auto`; `fileMatchPattern` string or array;
  `#[[file:<relative_file_name>]]` links "live workspace files", and an unresolved reference leaves a visible marker
  (not silently dropped). Design is fixed: file references, no copy, no fallback. The guard checks every reference
  resolves. Note from the same page: Kiro also auto-includes `AGENTS.md` (both repos have one — the Codex repo-scope
  rule, harmless and consistent), and Kiro CLI V1/V2 skip `fileMatch` files (V3 loads them) — so the scoped files are
  a bonus, the `always` file carries the rules. The Operator's Kiro CLI engine reads the same `.kiro/steering/` in its
  repo worktree, so the Operator gets the rules too.
- **F3 [minor] — ACCEPTED.** Add `.kiro/` to the gateway's `.dockerignore` (and vitana-v1's if one exists) so it never
  enters an image.
- **F4 [minor] — ACCEPTED.** vitana-v1's `always` file also references `.claude/CLAUDE.md`.
- **F5 [minor] — REJECTED.** No reviewer action needed; plain markdown renders normally.
- **F6 [minor] — ACCEPTED as a recorded trade-off.** Same always-on load Claude Code carries today (parity);
  `vitana-kiro-notes.md` states it. No curated subset — that would be a second source of truth.
- Q1/Q2/Q3 answered under F2/F1/F4.

## Planner responses — round 2 (partner verdict: CONVERGED)
- F7 [minor] — ACCEPTED: change class relabelled standard (it touches `.github`), no other change.

## Approval
Plan hash: 53683fcf7f2646c3 (sha256 of the plan:begin..plan:end block, first 16 hex). Verdict: CONVERGED (round 2).
Owner approval: 2026-10-10, Gate 1 "Yes". VTID allocated after approval: VTID-05059 (one VTID, both repos).
