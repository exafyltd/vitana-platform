# VTID-04758 — RepoWise + Graphify actually usable in Claude Code sessions

Checked live on 2026-10-01: no Claude Code session had either tool. In this
session `repowise`/`graphify` were not installed, no RepoWise MCP tool was
loaded and there was no `graphify-out/`. CI was healthy (CODEINTEL-INDEX run
#268 built both repos and `latest/` matched `main`), so the gap was entirely
on the session side:

1. The SessionStart hook ran only from a repo's `.claude/settings.json`; a
   multi-repo session (working directory `/home/user`) never loads it, nor any
   repo `.mcp.json`.
2. When it did run, it rebuilt RepoWise inside its 300 s timeout, though a full
   vitana-platform build takes ~10 min (run #268 step: 9 m 48 s), so it was
   killed half-way.
3. Session clones are shallow (141 / 70 commits), so even a finished local
   build had thin git history (hotspots, ownership, bug fixes).
4. `.repowise/decisions.yaml` is committed, so on a fresh clone
   `[ -d .repowise ]` chose `repowise update` against an index that did not
   exist.
5. `.mcp.json` runs bare `repowise`, which is not on the default PATH.

Fix: `scripts/codeintel/session-setup.sh` (byte-identical copy in
`exafyltd/vitana-v1`) installs the tools in the foreground and links them into
`/usr/local/bin`. It then indexes in a detached, flock-guarded worker:
- RepoWise is seeded from the full-history index CI now also publishes
  (`repowise-index.tar.gz`, manifest `session_seed`), re-pointed at the
  checkout, then updated incrementally.
- Graphify builds locally.
- Both post-commit hooks are installed.

`--register-mcp` registers user-scope `repowise-<repo>` servers for multi-repo
sessions, via the environment setup script (`docs/CODEINTEL-SESSION-SETUP.md`).
The hooks become thin delegates.

Findings measured while building it (details in `commands.log`):
- **Relocating the index.** A RepoWise index copied to another path reads as
  empty ("Database -> 0 pages") until `repositories.local_path` is rewritten.
  That is the only stored copy of the build path.
- **Graphify seeding.** Its AST cache does not survive the move: a seeded
  update re-parsed 4379 files in 176 s, the same as a full build. So Graphify
  is not seeded.
- **Config changes force a full re-render.** Any config-file change
  (`.repowise/config.yaml`, or a `.yml` in the repo) regenerates every page;
  a `.ts` change regenerates 1. Editing the seed's config in the session
  therefore re-rendered all 6705 pages (872 s). CI now builds the seed with
  `--no-claude-md --no-agents`, and the session edits config only for an
  older seed.
- **`init` stamps a stale config fingerprint.** `repowise init --no-claude-md
  --no-agents` records `config_fingerprint` before writing those flags into
  `config.yaml`, so the first update after any such init re-renders every page
  (6703, 819 s), relocated or not. CI now re-stamps it with RepoWise's own
  functions (`scripts/codeintel/repowise_restamp_config.py`). Result: the
  first session update regenerated 1 page.
- **Steady state is incremental.** `git commit` returns in 0 s (both hooks run
  in the background). The post-commit RepoWise update processed 1 file and
  1 page (2 m 47 s, mostly the whole-graph refresh); a no-op update takes 3 s.
- **A running MCP server picks up a later index.** Started on a repo with no
  index, `repowise mcp` answers "no index yet". The same process serves the
  real overview once the worker finishes, so the session-start timing works.
- **`graphify hook install` wrote an untracked `.gitattributes`.** That would
  be a stray change in every session; its line now goes to
  `.git/info/attributes`.
- **`claude mcp add -e … name`** failed because `-e` is variadic and swallowed
  the name; the name now comes first.

VALIDATION_PROFILE: gateway_backend

## Acceptance Criteria

AC-1 — CODEINTEL-INDEX packages the RepoWise index (WAL folded in; no `decisions.yaml`, export, `mcp.json` or parse cache), records `session_seed` (format, build root, version, file) in the manifest, and uploads it under `<sha>/` before `latest/manifest.json` moves. Consumers of the existing bundle are unaffected.
TEST: services/gateway/test/vtid-04758-codeintel-session-setup.test.ts

AC-2 — CI builds the seed with `--no-claude-md --no-agents` and re-stamps the config fingerprint before the export, so a session's first update on the seed is incremental (never edits the seed config, never a false "config changed").
TEST: services/gateway/test/vtid-04758-codeintel-session-setup.test.ts

AC-3 — `session-setup.sh` is valid bash, installs in the foreground and indexes in a detached flock-guarded worker, judges an index by pages for THIS checkout, re-points a seeded index (`repositories.local_path`), never writes tracked editor files, and keeps graphify's merge driver out of the working tree.
TEST: services/gateway/test/vtid-04758-codeintel-session-setup.test.ts

AC-4 — `--register-mcp` registers user-scope `repowise-<repo>` servers, idempotently. Verified against a throwaway HOME: both servers written to `.claude.json` with the absolute `/usr/local/bin/repowise`.
TEST: services/gateway/test/vtid-04758-codeintel-session-setup.test.ts

AC-5 — The SessionStart hook runs only in remote sessions and delegates to the script; it is still registered in `.claude/settings.json`.
TEST: services/gateway/test/vtid-04758-codeintel-session-setup.test.ts

AC-6 — End to end with no seed published (today's real state): fresh clone, real S3 lookup (`NoSuchKey`), local build: `ready` in 19 s, tools on `/usr/local/bin`, both hooks installed, tree clean. A re-run reuses the index in 9 s.
TEST: outputs/e2e-fallback.txt

AC-7 — End to end with a seed from the workflow's own packaging step (run verbatim against a CI-equivalent build), on a fresh session-like clone one ordinary commit ahead of the seed:
- the hook returns in 0 s and the index is queryable in 7 s (3942 pages);
- the first update regenerates 1 page, and the run is `ready` (source `ci-seed`) in 340 s, Graphify included;
- the tracked tree is clean;
- the RepoWise MCP server answers `get_overview`, `search_codebase` and `get_context` while the worker is still running.
TEST: outputs/e2e-seed.txt

AC-8 — Live, after merge: the next CODEINTEL-INDEX run publishes `repowise-index.tar.gz` and a manifest with `session_seed` for both repos, and a new session reports `source: ci-seed` from `session-setup.sh --status`.
TEST: outputs/ — recorded after merge; NOT verified at PR time.

OASIS_PROOF: not applicable — developer tooling (session scripts, a CI index workflow); no runtime route, event or schema.
