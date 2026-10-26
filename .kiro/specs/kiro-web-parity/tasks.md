# Tasks — kiro-web-parity
Authoritative plan: `plan.md` (between the plan markers). Lane file: `lanes/session-kit.md`. VTID: allocated by CI
PLAN-SPAR after policy approval; never by hand. Branch `kiro/kiro-web-parity/session-kit`, PR title
`VTID-xxxxx (kiro-web-parity/session-kit): …`, trailers `Collab-Session` + `Collab-Lane` on every commit, identity
`kiro-agent[bot]`, no `Co-Authored-By: Claude` trailer, evidence in `docs/validation/<VTID>/` (`commands.log` with
every command and pass/fail counts, `red-on-base.txt`, `probes.md`, `parity-report.md`). Acceptance below is what the
reviewer agent `vitana-lane-reviewer` checks the PR diff against.

<!-- lane: session-kit -->
## Lane `session-kit` — setup, status, guard, mark-dirty, wait; parity docs
- [ ] K1 `scripts/collab/kiro-web-session.test.mjs` (plan §4 cases 1-7) written first; red on `origin/main` recorded
      in `docs/validation/<VTID>/red-on-base.txt`.
- [ ] K2 `scripts/collab/kiro-web-session.mjs` per plan §3 A (subcommands 1-5).
- [ ] K3 `docs/kiro-web-parity/README.md` per plan §3 B.
- [ ] K4 Evidence: `probes.md` (plan §2 observations with the commands and outputs), `parity-report.md` (plan §5).
- [ ] K5 Local checks: `node --test scripts/collab/*.test.mjs`; `kiro-web-session.mjs setup --wait` then
      `status --check` in the session workspace; a live guard demonstration (a blocked push on a failing preflight,
      a blocked commit on a seeded type error, both reverted); preflight on the lane head; all in `commands.log`.

**Acceptance**
- Only the lane's `paths` change; no rule file, protected gate file, `.kiro/steering/**`, `.kiro/pipeline/**`,
  `.kiro/hooks/**`, `AGENTS.md`, `docs/kiro/**`, `scripts/codeintel/**` or `CLAUDE.md` change.
- Every plan §4 case is a test that fails on `origin/main` and passes on the head.
- `setup` writes only under `<workspace>/.kiro/hooks/`, `<workspace>/.kiro/agents/` and `~/.cache/`, never inside a
  repository; it removes only files carrying its marker; one hook entry per generated file.
- `guard` only adds checks: it never skips, disables or loosens a check, never passes `--no-verify`, and blocks only on
  a real preflight / typecheck failure or a pushed sha that is not the checked-out HEAD; an internal error does not block.
- `wait` polls no faster than the plan's interval default and prints the failed run logs.
- The docs separate observed (with evidence) from documented and assumed behaviour, state that Claude Code parity is
  unverified without a direct comparison, and keep every stop case unchanged.
- Deploys nothing.
