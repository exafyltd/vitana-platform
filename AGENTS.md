# Repository Scope

Strict rule: Codex may only work with these GitHub repositories:

- `exafyltd/vitana-v1`
- `exafyltd/vitana-platform`

Codex must ignore every other GitHub repository. Do not inspect, search, clone,
modify, reference, create branches in, open pull requests against, or perform any
action in any repository outside this allowlist unless the user explicitly
changes this rule.

If a task appears to require another repository, stop and ask the user to confirm
that the repository scope rule should be changed before taking any action.

# Kiro Web: load the Vitana steering

This section applies only to a Kiro Web session, meaning a Kiro session whose workspace root is the folder the
repositories are cloned into (for example `/projects/sandbox`). Codex, Claude Code and Kiro IDE sessions ignore it.

Before anything else in such a session: if `.kiro/steering/vitana-platform--vitana-load-project-rules.md` does not
exist at the workspace root, run `node vitana-platform/scripts/collab/kiro-web-steering.mjs` from the workspace root,
confirm it ends with `kiro-web-steering: ok`, and then follow the loaded Vitana rules. Details:
`docs/kiro/kiro-web-bootstrap.md`.
# Autonomous Execution to Verified Staging (owner instruction, 2026-11-03)

The owner asked for end-to-end execution. Work in this repo runs without approval questions until STAGING-VERIFY passes
on the merge commit, or until a stop applies.

## Read first, every session
1. This file.
2. `CLAUDE.md`: Autonomy Contract, Staging Verification Gate, and the absolute rule against testing or writing to production.
3. `.kiro/steering/vitana-owner-autonomy.md`: the standing instruction and the one complete stop table. `.kiro/steering/vitana-pipeline.md`: the pipeline.
4. `.kiro/pipeline/` (`driver.md` for Kiro Web) and `.claude/rules/collaboration.md` §7 to §7c.
5. The same rules apply in `exafyltd/vitana-v1`. Clone it next to this repo when a task touches app code.

## Default end point
- A change that results in a commit goes through the Vitana pipeline to **STAGING-VERIFY passed on the merge commit**.
- A change that deploys nothing ends when it is merged with green checks.
- Gate 2 (*"Staging verified — ready for deployment to production?"*) is the report at the end. It is the only question about production.

## Do without asking
Investigating, reading code, logs and CI; writing code, tests and docs; running local checks; committing, pushing, opening
and updating PRs; running the reviewer agent; merging under `collaboration.md` §7b; dispatching or re-running staging,
verification and CI workflows; fixing forward up to 3 attempts per lane; writing closing records and removing your own
branches and worktrees. Do not end a reply with an offer or question about a routine next step.

## Stops
The only reasons to ask are the rows of the stop table in `.kiro/steering/vitana-owner-autonomy.md`. This file does not
copy the table, so the two cannot drift apart. When a stop applies, send one message with the five parts that section
and `collaboration.md` §7 name. Finish all other work first.

## Never
- Test against, write to, or deploy to production (`inmkhvwdcuyhnxkgfvsb`, `gateway.vitanaland.com`, any production Cloud Run or AWS service).
- Allocate a VTID by hand. VTIDs come only from CI PLAN-SPAR.
- Merge your own lane or accept your own review. Acceptance comes from the reviewer agent `vitana-lane-reviewer`.
- Skip, disable or loosen a test, force-push, or write to a live system from a session tool.
