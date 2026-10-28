# Tasks — kiro-web-steering
Authoritative plan: `plan.md` (between the plan markers). Lane file: `lanes/web-steering.md`. VTID: allocated by CI
PLAN-SPAR after policy approval; never by hand. Branch `kiro/kiro-web-steering/web-steering`, PR title
`VTID-xxxxx (kiro-web-steering/web-steering): …`, trailers `Collab-Session` + `Collab-Lane` on every commit, identity
`kiro-agent[bot]`, no `Co-Authored-By: Claude` trailer, evidence in `docs/validation/<VTID>/` (`commands.log` with
every command and pass/fail counts, `red-on-base.txt`). Acceptance below is what the reviewer agent
`vitana-lane-reviewer` checks the PR diff against.

<!-- lane: web-steering -->
## Lane `web-steering` — generator, AGENTS.md trigger, bootstrap docs
- [ ] T1 `scripts/collab/kiro-web-steering.test.mjs` (plan §4 cases 1–6) written first; red on `origin/main`
      recorded in `docs/validation/<VTID>/red-on-base.txt`.
- [ ] T2 `scripts/collab/kiro-web-steering.mjs` per plan §3 A (rules A1–A6).
- [ ] T3 `AGENTS.md`: append the "Kiro Web: load the Vitana steering" section (plan §3 B). It opens with the scope
      sentence (Kiro Web only; Codex, Claude Code and Kiro IDE ignore it). The existing Codex rule text stays
      byte-identical.
- [ ] T4 `docs/kiro/kiro-web-bootstrap.md` and `docs/kiro/cloud-config/vitana-kiro-web-bootstrap.md` (plan §3 C, D).
- [ ] T5 Local checks: `node --test scripts/collab/*.test.mjs`, `node scripts/collab/kiro-web-steering.mjs` then
      `--check` on the session workspace (both repos), preflight on the lane head; all in `commands.log`.

**Acceptance**
- Only the lane's `paths` change; no rule file, protected gate file, `.kiro/steering/**`, `.kiro/pipeline/**`,
  `.kiro/hooks/**` or `CLAUDE.md` change.
- Every plan §4 case is a test that fails on `origin/main` and passes on the head.
- The generator writes only under `<workspace>/.kiro/steering/`, never inside a repository, and deletes only files
  carrying its marker.
- `--check` on a real two-repo workspace exits 0 after a run and reports no unresolved or nested link.
- The docs separate documented (URL), observed (this session) and assumed behaviour, and keep every stop case
  (Gate 2, escalated sparring verdict, migration-file approval, §7 stop cases) unchanged.
- Deploys nothing.
- **R2-F1 (converging round, minor):** vitana-v1 has `.kiro/steering/` today (8 files at `fb9b6d843`). A known Vitana
  checkout (origin `exafyltd/vitana-platform|vitana-v1`) under the workspace without `.kiro/steering/` is skipped
  with a printed note (`--json`: `skipped`), not an error, and a test covers it.
