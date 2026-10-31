# Context map: where each answer lives

One page so a session (Kiro, Claude Code, Codex) finds the source of truth for a question in one step, not by
browsing. Paths are in vitana-platform unless they start with `vitana-v1/`. Nothing here copies the answers. Each row names the file that owns the answer, and
`scripts/dev/context.mjs` reads that file live, both repos, read-only, git only (no index, token or network needed).
Run it from the vitana-platform checkout; it finds `../vitana-v1` itself (or `--v1 <dir>` / `VITANA_V1_DIR`).

| Question | First command | Source of truth | How drift shows up |
|---|---|---|---|
| Which handler serves gateway route X? | `node scripts/dev/context.mjs route "POST /api/v1/vtid/allocate"` | mount table in `services/gateway/src/index.ts`, then `services/gateway/src/routes/*.ts` | parsed live |
| Which page renders a vitana-v1 path, is it registered? | `node scripts/dev/context.mjs screen /inbox` | `vitana-v1/src/App.tsx`, `vitana-v1/src/navigation/registry/screens.json`, `vitana-v1/src/design/screen-manifest.json`, `vitana-v1/apps/mobile/parity/ledger.json` | `vitana-v1/src/navigation/registry/registry.routes.test.ts`, NATIVE-CI |
| What belongs to an area (route files, code, tables, flags, docs)? | `node scripts/dev/context.mjs domain autopilot` | `services/gateway/src/orb/developer/domain-atlas.ts` | route claims: `services/gateway/test/vtid-04560-role-separation-regression.test.ts`; code/doc pointers: `check` |
| Who imports a file, which tests cover it? | `node scripts/dev/context.mjs uses <file>` | the import statements | parsed live; `graphify explain "<file>"` adds calls once the graph is built |
| Why is it built this way, is there a rule? | `node scripts/dev/context.mjs why <term>` | `CLAUDE.md`, `.claude/rules/*.md`, `docs/CHANGELOG.md`, `docs/CHANGELOG-ARCHIVE.md`, `docs/decisions/`, `.repowise/decisions.yaml` (both repos) | dead paths in rule files: `check`; rule text silent → `git log -S '<term>'` |
| Was this done before, where does VTID X stand? | `node scripts/dev/context.mjs vtid VTID-05300 --prs` | git history, `.kiro/specs/<slug>/`, `docs/validation/<VTID>/`, PRs | git is the state; the ledger row needs `scripts/dev/resume-vtid.sh` + token |
| Which regression suite must stay green? | `node scripts/dev/context.mjs why regression.test` | `CLAUDE.md` rules 42c-42h | the suites themselves |
| Which lanes are open, who holds them? | `node scripts/collab/queue.mjs --repo . --repo ../vitana-v1` | `.kiro/specs/*/lanes/*.md` | `queue.mjs validate` |
| Table or column? | `git grep -n '<table>' -- DATABASE_SCHEMA.md supabase/migrations` | `supabase/migrations/` (the schema doc follows it, ALWAYS 24) | migration order |
| Which workflow deploys or tests X? | `node scripts/dev/context.mjs why <service or workflow>` | `.claude/rules/infrastructure.md`, `.github/workflows/` | workflow `paths:` filters |

## Code intelligence (RepoWise, Graphify)
In Kiro Web they are CLI-only (`~/.cache/vitana-codeintel/venv/bin`, no MCP) and usable only after the session's
code-intelligence install has finished (436 s measured). Measured 2026-10-27
(`docs/validation/VTID-05349/outputs/measurement.md`):
- `graphify explain "<file>"`: imports in both directions with `file:line`, about 6 s. Use it for dependency questions
  after `uses`.
- `repowise context <file>`: bug-fix and hotspot history, about 2 s. Use it before you edit a risky file.
- `repowise search`: full-text only here (semantic search unavailable). It did not return `routes/vtid.ts` for "vtid
  allocate route handler". For exact lookups use `route`, `uses` or `git grep`.

## Not a source of truth (history only)
- `second-brain/`: a frozen copy of 2026-04..10 docs (`raw/`) and a wiki last edited 2026-10-03; it predates the
  AWS cutover rules. Cite the original file instead.
- The `REPOWISE:START` block in `.claude/CLAUDE.md` (both repos): a generated snapshot. `check` prints how many
  commits behind HEAD it is; its file counts and hotspots are not current.
- Plan, handoff and lane files under `.kiro/specs/**` and dated reports in `docs/` record what was true then. Rule text
  on `origin/main` wins.

## Stale-link check
`node scripts/dev/context.mjs check` lists dead `file` pointers in the atlas and in the rule files sessions load, atlas
route patterns that claim no file, this page's own links (an error), and how far the RepoWise/Graphify indexes are
behind HEAD. It exits non-zero only on errors in this page (`--strict` also fails on warnings). The unit test
`scripts/dev/context.test.mjs` runs it in CI (`UNIT.yml`), so a dead link on this page fails the PR that causes it.
