# VTID-05340 — acceptance (lane kiro-web-parity/session-kit; criteria from `.kiro/specs/kiro-web-parity/tasks.md`)

| AC | Criterion | Proof |
|---|---|---|
| AC-1 | Only the lane's `paths` change | PR files: `scripts/collab/kiro-web-session.mjs`, `.test.mjs`, `docs/kiro-web-parity/README.md`, `docs/validation/VTID-05340/**`, the lane file; Lane scope green |
| AC-2 | Every plan §4 case is a test, red on base, green on head | `red-on-base.txt` (ERR_MODULE_NOT_FOUND on `e6fd6dfc2b`); TEST: `scripts/collab/kiro-web-session.test.mjs` 21/21 (§4.1-2 setup/hooks/reviewer, §4.3 mark-dirty, §4.4 parseCommand incl. PR_TITLE forms, §4.5 guard decisions, §4.6 wait, §4.7 status + no-network morning pack) |
| AC-3 | `setup` writes only under `<workspace>/.kiro/hooks`, `<workspace>/.kiro/agents`, `~/.cache`; removes only marked files; one hook per file | TEST: "setup writes exactly the two marked hook files…", "setup removes a stale marked hook…", "from a linked worktree the workspace is the main checkout's parent…" |
| AC-4 | `guard` only adds checks, blocks only on real failures / sha ≠ HEAD / commit+push in one command; internal errors never block | TEST: "guard blocks a lane push on a failing preflight…", "…not the checked-out HEAD, and a commit+push…", "guard typechecks the gateway on commit…", "guard never blocks on its own internal error", "only the ci-plan-spar _plan-session false positive passes…"; live: `probes.md` demonstrations |
| AC-5 | `wait` polls at the given interval (default 120 s) and prints failed run logs | TEST: the three `wait` cases |
| AC-6 | Docs separate observed / documented / assumed, say parity is unverified, keep every stop case | `docs/kiro-web-parity/README.md`, `parity-report.md` |
| AC-7 | Deploys nothing | no AWS-STAGE/PROD deploy path touched; no STAGING-VERIFY, no Gate 2 |
