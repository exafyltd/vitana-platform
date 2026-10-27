# VTID-05340 — acceptance (lane kiro-web-parity/session-kit; criteria from `.kiro/specs/kiro-web-parity/tasks.md`)

AC-1: Only the lane's `paths` change (the script, its test, `docs/kiro-web-parity/**`, `docs/validation/VTID-05340/**`,
the lane file); no rule file, protected gate file, `.kiro/steering/**`, `.kiro/pipeline/**`, `.kiro/hooks/**`,
`AGENTS.md`, `docs/kiro/**`, `scripts/codeintel/**` or `CLAUDE.md`.
TEST: PR-GATE "Lane scope" on the PR head (queue.mjs scope-check), and `git diff --stat origin/main...HEAD`.

AC-2: Every plan §4 case is a test that fails on `origin/main` and passes on the head.
TEST: `node --test scripts/collab/kiro-web-session.test.mjs` — red on base (`red-on-base.txt`, ERR_MODULE_NOT_FOUND),
24/24 on head (`outputs/kiro-web-session-test-green.txt`).

AC-3: `setup` writes only under `<workspace>/.kiro/hooks/`, `<workspace>/.kiro/agents/` and `~/.cache/`, never inside a
repository; removes only marked files; one hook entry per generated file; from a worktree the workspace is the main
checkout's parent.
TEST: scripts/collab/kiro-web-session.test.mjs "setup writes exactly the two marked hook files…", "setup removes a stale
marked hook…", "reviewer agent copy is byte-identical…", "from a linked worktree the workspace is the main checkout's parent…".

AC-4: `guard` only adds checks; it blocks only on a real preflight / typecheck failure, a pushed sha that is not the
checked-out HEAD, or commit+push in one command; it never blocks on its own internal error.
TEST: scripts/collab/kiro-web-session.test.mjs "guard blocks a lane push on a failing preflight…", "guard asks for
PR_TITLE…", "guard blocks a push whose sha is not the checked-out HEAD…", "guard typechecks the gateway on commit…",
"guard installs missing gateway dependencies…", "guard never blocks on its own internal error", "only the ci-plan-spar
_plan-session false positive passes…"; live demonstrations in `probes.md`.

AC-5: `wait` polls no faster than the given interval (default 120 s) and prints the failed run logs.
TEST: scripts/collab/kiro-web-session.test.mjs "wait returns 0…", "wait returns 1 with the failed run name, link and log
tail", "wait returns 3 on timeout…".

AC-6: `status --check` reports readiness without printing a token value; `setup --no-install` makes no network call.
TEST: scripts/collab/kiro-web-session.test.mjs "status reports missing hooks…", "status: workspace steering is the
kiro-web-steering --check result…", "setup --no-install never fetches the morning pack…".

AC-7: The docs separate observed (with evidence) from documented and assumed behaviour, state that Claude Code parity
is unverified, and keep every stop case unchanged; the change deploys nothing.
TEST: review of `docs/kiro-web-parity/README.md` and `parity-report.md`; no AWS-STAGE/PROD deploy path in the diff.
