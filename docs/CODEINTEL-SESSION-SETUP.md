# Codebase intelligence in Claude Code sessions (VTID-04758)

RepoWise and Graphify back the "Mandatory Codebase Intelligence Workflow" in
`CLAUDE.md`. This page is how a session actually gets them.

## How it works

| Piece | Where | What it does |
|---|---|---|
| CI index | `.github/workflows/CODEINTEL-INDEX.yml` | On every merge to `main`, builds RepoWise (full git history) and Graphify for `vitana-platform` and `vitana-v1`, publishes the Operator Console/executor bundle **and** the RepoWise index itself (`repowise-index.tar.gz`, manifest `session_seed`) to `s3://vitana-code-index/<owner>/<repo>/<sha>/`. |
| Session setup | `scripts/codeintel/session-setup.sh` (byte-identical copy in `exafyltd/vitana-v1`) | Installs both tools (foreground, ~1 min fresh / seconds cached) and links them into `/usr/local/bin`. Then, detached: seeds RepoWise from the CI index, re-points it at the checkout and runs `repowise update` for the commits since; builds Graphify locally (~2-3 min); installs both post-commit hooks so later commits keep the indexes current. |
| Per-repo hook | `.claude/hooks/session-start-codeintel-setup.sh` | Runs the script for that repo — **only when the session's working directory is that repo.** |
| MCP | `.mcp.json` (per repo) or `--register-mcp` (user scope) | Starts `repowise mcp <repo>`. |

Why seed RepoWise instead of building it in the session: a full
vitana-platform index takes ~10 min (CI run #268: 9 m 48 s), session clones
are shallow (~100 commits) so a local build has almost no hotspot/ownership/
bug-fix history, and the old hook's 300 s timeout killed the build half-way
every time. Graphify is not seeded: its AST cache does not survive a move
between checkouts, so a seeded update measured 176 s — the same as building it.

## Multi-repo sessions (working directory `/home/user`)

A multi-repo session never loads a repo's `.claude/settings.json` or
`.mcp.json`, so nothing above runs on its own. Add this to the cloud
environment's **Setup script** (environment menu in the session title bar →
Edit):

```bash
# Codebase intelligence: RepoWise + Graphify for every repo (VTID-04758)
S=/home/user/vitana-platform/scripts/codeintel/session-setup.sh
[ -f "$S" ] && bash "$S" --register-mcp /home/user/vitana-platform /home/user/vitana-v1 || true
```

It installs the tools before Claude Code starts (so the MCP servers can launch
at session start), starts indexing, and registers user-scope MCP servers
`repowise-vitana-platform` and `repowise-vitana-v1`. If the repositories are
not cloned yet when the setup script runs, the script skips them and logs why;
the per-repo hooks still cover single-repo sessions.

## Checking it

```bash
bash /home/user/vitana-platform/scripts/codeintel/session-setup.sh --status
```

Per repo: `state` (`indexing` / `ready` / `degraded` / `never-run`), the
`head` indexed, RepoWise `source` (`ci-seed`, `existing`, `local-build`) and
page count. Logs: `~/.cache/vitana-codeintel/<repo>.log`.

Measured on vitana-platform (fresh clone, one commit ahead of the seed): the
hook returns at once, the RepoWise index is queryable after ~7 s, its first
update regenerates only the changed page (~3.5 min, mostly the whole-graph
refresh), and everything including Graphify is `ready` after ~6 min. Without a
seed RepoWise builds locally (~10 min, thin history).

CI re-stamps RepoWise's config fingerprint after `init`
(`scripts/codeintel/repowise_restamp_config.py`): `init --no-claude-md
--no-agents` stamps it before writing those flags, and any config change makes
`update` re-render every page (measured 6703 pages, ~14 min) — so without the
re-stamp the first update in every session would be a full rebuild.

## Knobs

| Variable | Effect |
|---|---|
| `CODEINTEL_GRAPHIFY_LABEL=0` | Skip the Bedrock community-labelling pass (VTID-04121). It runs after every Graphify build when AWS credentials are present and costs Bedrock tokens (~160k input per vitana-platform run, `docs/codeintel/COMMUNITIES.md`). |
| `CODEINTEL_SKIP_SEED=1` | Build RepoWise locally instead of seeding. |
| `CODE_INDEX_LOCAL_DIR` | Read the bucket layout from a local directory (testing). |
| `CODEINTEL_STATE_DIR` | Status/log/lock directory (default `~/.cache/vitana-codeintel`). |

## Known limits

- A session restart can kill the detached worker; the next session start
  resumes it (`repowise init --resume` for an interrupted local build).
- `vitana-v1`'s CI index refreshes only when `vitana-platform` merges (the
  workflow lives here); a seed can be a few commits behind and `repowise update`
  covers the gap.
- A commit that changes a config file (a workflow `.yml`, `.repowise/config.yaml`)
  makes RepoWise re-render every page — RepoWise behaviour, not this setup.
- The seeded overview page is titled after CI's checkout directory (`src`) until
  it is next re-rendered; the repository row itself is renamed on seeding.
- RepoWise prose synthesis (`get_answer`) needs a provider key in the MCP
  server's environment; without one, index/search/context/risk/health/why still
  work.
