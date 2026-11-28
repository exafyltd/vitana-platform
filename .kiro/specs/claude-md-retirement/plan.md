---
change_class: standard
---
# Plan — claude-md-retirement

Repo: `exafyltd/vitana-platform` only. Authored in Claude Code on the owner's instruction (2026-11-17): retire the root
`CLAUDE.md` (644 lines, the canonical rules) and make `.claude/rules/governance.md` the single canonical copy. Step 1
(rename `second-brain/CLAUDE.md`, remove the generated `.claude/CLAUDE.md`) is a separate PR (#5108) and is not part of this plan.

Premises checked on `origin/main` 67897e6c:
- Runtime readers of the root file: `services/gateway/src/services/autopilot-agent/run-agent-execution.ts:96`,
  `services/gateway/src/services/operator-bootstrap-pack.ts:361`, `services/gateway/src/services/kiro/kiro-push-branch.ts:20`.
- Protected-list copies that name `CLAUDE.md`: `scripts/collab/protected-gate-files.json:5`, `scripts/collab/queue.mjs:92,99,139`,
  `services/gateway/src/services/project-manager/governance.ts:49,74`.
- Other scripts with a literal dependency: `scripts/collab/plan-driver.mjs:37`, `scripts/eng/rehearse.mjs:80`,
  `scripts/eng/gitlab-land.mjs:554`, `scripts/eng/assist-trigger.mjs` (protected files), `scripts/dev/context.mjs:248,278,318,391`.
- CI trigger: `.github/workflows/CODEINTEL-INDEX.yml:50`.
- Tests that read the root file: `services/gateway/test/console-task-12-bootstrap-flag-visibility.test.ts:22`,
  `services/gateway/test/vtid-04018-operator-bootstrap-pack.test.ts:21`, `services/gateway/test/vtid-04019-no-token-prefixes-in-docs.test.ts:47`,
  `services/gateway/test/vtid-04868-plan-sparring-session-layer.test.ts:29`, plus the script tests listed in lane `protected-lists`.
- Path-scoped rule files (`.claude/rules/backend.md`, `collaboration.md`, `infrastructure.md`) carry `paths:` front matter; a rule
  file with no `paths:` loads on every session, so `.claude/rules/governance.md` with no front matter is the always-loaded canonical copy.

<!-- plan:begin -->
## 1. Goal
Remove the root `CLAUDE.md` in one PR, with one canonical guidance file that every runtime reader, protected list, CI trigger,
hook and test points at. Nothing that reads the rules loses them.

## 2. Design
- Canonical file: `.claude/rules/governance.md`, a verbatim copy of the root `CLAUDE.md` (pure move, no rule changed or dropped),
  with no `paths:` front matter so it loads on every session.
- Readers resolve the canonical path through one constant per language (TS: `GOVERNANCE_RULES_PATH`; script: the same literal),
  and fail with a clear error if it is missing. No fallback to `CLAUDE.md`: the old name must be gone so nothing silently reads a stale copy.
- Protected list: the `CLAUDE.md` entry becomes `.claude/rules/governance.md` in all three copies (JSON, `queue.mjs`
  built-in, `governance.ts`), and the same change keeps the file protected.
- CI: `CODEINTEL-INDEX.yml` triggers on `.claude/rules/**` instead of `CLAUDE.md`.
- Hooks and agent text: `.claude/hooks/pretooluse-plan-sparring-reminder.sh`, `.claude/agents/plan-sparring-partner.md:14`
  and `.claude/skills/plan-sparring/SKILL.md:11` point at the canonical path.
- Root `CLAUDE.md` is deleted in the same PR, after the readers and tests are changed to the canonical path.

## 3. Compatibility and deploy order
- Staging auto-deploys on merge; production is a manual publish (CLAUDE.md IF–THEN 21–23). Between a merge and the
  production publish, the production gateway still runs the old readers, which read `CLAUDE.md`. Those readers will fail to
  find the file. Mitigation: the owner publishes the gateway build from this PR to production before or with the merge (or
  holds the merge until the publish). This is a stop condition for the owner, not something the PR can enforce.
- The Kiro steering and collaboration docs that cite the root file (`.kiro/steering`, `.kiro/pipeline/*`) are docs only; they are
  updated in lane `ci-hooks-docs` so they stop pointing at a missing file.
- Comments that cite rule numbers (`CLAUDE.md §4.1`, `IF–THEN 26`) are not rewritten; they name rules, which now live in the canonical file.

## 4. Lanes
- `guidance-file`: create `.claude/rules/governance.md` (verbatim copy) and delete the root `CLAUDE.md`. Protected gate file.
- `runtime-readers`: the three runtime readers in §1 and `services/gateway/src/services/project-manager/governance.ts`
  (the list mirror lives with the readers). Protected gate file (`project-manager/governance.ts`).
- `protected-lists`: `scripts/collab/protected-gate-files.json`, `scripts/collab/queue.mjs`, `scripts/collab/plan-driver.mjs`,
  `scripts/eng/rehearse.mjs`, `scripts/eng/gitlab-land.mjs`, `scripts/eng/assist-trigger.mjs`, `scripts/dev/context.mjs`, and the
  tests that read the root file or its fixtures.
- `ci-hooks-docs`: `.github/workflows/CODEINTEL-INDEX.yml`, the hook and agent/skill text, `.claude/rules/collaboration.md` §3a
  (protected list text), and the `.kiro/steering` and `.kiro/pipeline` files that cite the root file.

## 5. Test plan
- With the root file absent, these pass: `services/gateway` jest suites for the readers (`console-task-12`, `vtid-04018`,
  `vtid-04019`, `vtid-04868-session-layer`, `project-manager/governance`, `scripts/validator-path-guard`).
- `scripts/collab` node tests: `queue.test.mjs`, `land-guard.test.mjs`, `kiro-web-steering.test.mjs`, `plan-driver.test.mjs`.
- `scripts/eng` tests: `rehearse.test.mjs`, `gitlab-land.test.mjs`, `assist-trigger` (if present), `pipeline-gen.test.mjs`.
- `scripts/dev/context.test.mjs`, `scripts/ci/kiro-steering/guard.test.cjs`.
- A new check: no file under `services/`, `scripts/` or `.github/` reads the literal path `CLAUDE.md` except comments.
- Not verified: that the production gateway reads the canonical file (requires the production publish, owner action).

## 6. Out of scope
- Rewriting rule-number comments across the repo.
- The vitana-v1 repository: its root `CLAUDE.md` is already removed (PR #1691).
- Step 1 (second-brain rename, `.claude/CLAUDE.md` removal): PR #5108.
<!-- plan:end -->
