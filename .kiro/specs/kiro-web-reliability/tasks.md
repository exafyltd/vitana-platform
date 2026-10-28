# Tasks — kiro-web-reliability
Authoritative plan: `plan.md` (between the plan markers). VTIDs: allocated by CI PLAN-SPAR, one per lane; never by
hand. Every lane: branch `kiro/kiro-web-reliability/<lane-id>`, PR title `VTID-xxxxx (kiro-web-reliability/<lane-id>): …`,
trailers `Collab-Session` + `Collab-Lane` on every commit, identity `kiro-agent[bot]`, no `Co-Authored-By: Claude`,
evidence in `docs/validation/<VTID>/` (`acceptance.md` with `AC-n` + `TEST:` lines, `commands.log`, `outputs/`,
`red-on-base.txt`, `scope.json`, `plan-sparring.md`), PR body with the five VALIDATOR-CHECK declarations. The two lanes
are built in parallel by separate builder sessions (plan §3.2.4) and share no file.

<!-- lane: preflight-validator -->
## Lane `preflight-validator` — VALIDATOR-CHECK in preflight (plan §3.1)
- [ ] V1 tests first in `scripts/collab/preflight.test.mjs` (plan §3.1.4), red on `origin/main` recorded.
- [ ] V2 `--body-file` and the `VALIDATOR-CHECK` check in `scripts/collab/preflight.mjs` (plan §3.1.1-3).
- [ ] V3 `node --test scripts/collab/*.test.mjs`; preflight on the lane head with `--body-file`; evidence.

**Acceptance**
- Only `scripts/collab/preflight.mjs`, `scripts/collab/preflight.test.mjs`, `docs/validation/<VTID>/**` change.
- The check runs the base revision's VALIDATOR-CHECK step scripts (nothing re-implemented), skips when no changed file
  is in the workflow's paths, excludes only `Build Gate` (reported), rewrites `/tmp/`, fails loudly on an unsupported
  expression or a parse error, and fails without `--body-file` when it applies.
- A platform-side "Not run by preflight" entry names the Build Gate whenever the check applies.
- Every plan §3.1.4 case is a test, red on base, green on head. No existing preflight test is weakened.
- Evidence only under this lane's own `docs/validation/<VTID>/`.

<!-- lane: session-reliability -->
## Lane `session-reliability` — bootstrap, git hooks, sequencing, parallel builders, refresh (plan §3.2)
- [ ] S1 tests first in `scripts/collab/kiro-web-session.test.mjs` (plan §3.2.7), red on `origin/main` recorded.
- [ ] S2 `scripts/collab/kiro-web-session.mjs` per plan §3.2.1-2, 5-6 (foreground installs, `--codeintel`, EPIPE-safe).
- [ ] S3 `AGENTS.md` (plan §3.2.1; the Codex rule byte-identical), `.kiro/pipeline/driver.md` (plan §3.2.3-4),
      `docs/kiro-web-parity/README.md`.
- [ ] S4 Live evidence: simulated fresh sandbox; race reproduction blocked by `pre-commit`; `commit && push` checked by
      `pre-push`; all in `commands.log`.

**Acceptance**
- Only the lane's paths change; no `CLAUDE.md`, `.claude/**`, `.kiro/steering/**`, `.kiro/hooks/**` or protected gate file.
- Git hooks carry the marker, never overwrite an unmarked hook, block only on a real tsc/preflight failure and never on
  an internal error; nothing tells an agent to use `--no-verify`.
- The PreToolUse guard no longer blocks `commit && push`; the pre-push hook checks the pushed sha.
- `driver.md` keeps every §7/§7a/§7b/§8a rule: one merge at a time, caps, hot files, reviewer independence; builders
  never merge, review or edit `handoff.md`. No owner-question phrases or machine paths (steering guard).
- Every plan §3.2.7 case is a test, red on base, green on head.
- Evidence only under this lane's own `docs/validation/<VTID>/`.
