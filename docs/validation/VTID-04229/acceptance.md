# VTID-04229 — Codebase index for all agents (build plan W6)

## Gap (docs/AGENT-REGISTRY.md §3, VTID-04222)

CLAUDE.md's "Mandatory Codebase Intelligence Workflow" names RepoWise and
Graphify; VTID-04116/04118 wired `dev_repowise`/`dev_graphify` to CLIs baked
into the gateway image. That never worked: `repowise` depends on `lancedb`,
which publishes no musl wheel, so the Alpine `pip install` fails and both
tools reported `not_configured` on every deployment (verified live on
staging). The agent executor had no index at all.

## Fix

- **Build on CI, not in the image.** `.github/workflows/CODEINTEL-INDEX.yml`
  runs on every merge to `main` (ubuntu): `graphify update . --no-cluster`,
  `repowise init --no-prose -y`, `repowise export --format json --full`,
  then `scripts/codeintel/build-code-index.mjs` derives a self-contained
  bundle (compact graph + per-file risk facts, ~1.6 MB gzipped for this
  repo) and publishes it to `s3://vitana-code-index/<repo>/<sha>/` and
  `<repo>/latest/manifest.json` (pointer written last). Both repos.
- **One loader, two agents.** `services/gateway/src/services/codeintel-index.ts`
  loads the bundle (S3 via `@aws-sdk/client-s3`, or `CODE_INDEX_LOCAL_DIR`),
  caches it per repo by sha (latest re-resolved every 10 min) and answers
  three pure queries: `dev_index_query` (token-scored seeds + neighbour
  walk), `dev_graph_path` (BFS shortest path), `dev_get_risk` (RepoWise
  history/ownership/hotspot/dead code + graph import fan-in).
- **Operator Console:** the three tools on the wire schema (developer/admin,
  gated by the existing `OPERATOR_CODEINTEL_ENABLED`, already `true` on
  staging); `dev_repowise`/`dev_graphify` answer from the index when their
  CLI is `not_configured`; the codebase-orientation prompt block names them.
- **Executor:** `pullCodeIndex` (agent-workspace.ts) loads the same bundle at
  run start (`runner:code_index` step, stats in the OASIS payload), the
  same three tools are declared only when it loaded (`agentToolsFor`), and
  the system prompt tells the model to query the index before grepping.
  Switch: `AGENT_CODE_INDEX_ENABLED` (default on).
- **Provisioning:** `scripts/aws/setup-code-index-bucket.sh` (dry-run
  default, `--apply`): bucket, public-access block, encryption, lifecycle,
  a bucket policy granting read to `vitana-ecs-task-role` and publish to
  the GitHub-OIDC deploy role, plus the equivalent role policies; every
  step's denial is recorded verbatim instead of aborting.

## Acceptance Criteria

AC-1 — The bundle builder turns a Graphify graph + RepoWise export into manifest + gzipped graph/risk indexes, deduping edges, dropping dangling links and parsing file-page prose into per-file facts.
TEST: services/gateway/test/vtid-04229-code-index.test.ts — "build-code-index.mjs" block (3 tests, run against the real script via node).

AC-2 — The loader resolves `latest/manifest.json` → `<sha>/`, assembles adjacency + label/file indexes, caches by sha, and reports a plain reason (never throws into a turn) when nothing is published or the repo is unknown.
TEST: services/gateway/test/vtid-04229-code-index.test.ts — "loadCodeIndex" block (4 tests).

AC-3 — `indexQuery` finds a symbol's container, callers, importing tests and referencing docs, honours the character budget, and refuses an empty/stop-word query rather than scanning the whole graph.
TEST: services/gateway/test/vtid-04229-code-index.test.ts — "pure queries" block; measured on the real bundle: load 244 ms, query 30–48 ms, path 6 ms, risk 1 ms (commands.log).

AC-4 — `graphPath` resolves by id/label/path/suffix (file node outranks its symbols) and returns the shortest undirected path with relations; `getRisk` merges RepoWise facts with graph import fan-in and names the closest paths on a miss.
TEST: services/gateway/test/vtid-04229-code-index.test.ts — "graphPath …", "getRisk …", "runCodeIndexTool …".

AC-5 — The executor declares the three tools only when a bundle loaded, answers them from the bundle, refuses honestly without one, pulls the index before the system prompt is built, and passes the per-run tool list to every router call.
TEST: services/gateway/test/vtid-04229-code-index.test.ts — "executor" block (5 tests incl. the runner source contract).

AC-6 — The Operator Console tools are gated by `OPERATOR_CODEINTEL_ENABLED`, developer/admin only, answer with the published sha, report the loader reason when nothing is published, and `dev_repowise`/`dev_graphify` fall back to the index only on `not_configured` (a real CLI error still passes through).
TEST: services/gateway/test/vtid-04229-code-index.test.ts — "Operator Console" block (5 tests); VTID-04116 suite unchanged and green.

AC-7 — The workflow runs on merge to main for both repos, uses the same build commands the bundle expects, publishes via OIDC to `<repo>/<sha>/` and writes `latest/manifest.json` last; the setup script is dry-run by default, refuses the wrong account and never grants delete.
TEST: services/gateway/test/vtid-04229-code-index.test.ts — "CODEINTEL-INDEX.yml + setup script" block (4 tests).

AC-8 — Live: the bucket exists with a bootstrap bundle and `latest/` pointer, and the task-role read grant is in place.
CURL: `aws s3 ls --recursive s3://vitana-code-index/` → outputs/s3-listing-2026-09-21.txt (graph-index.json.gz 1,216,250 B, risk-index.json.gz 407,187 B, manifest.json ×2 under 9545b190… and latest/); `setup-code-index-bucket.sh --apply` → outputs/setup-code-index-bucket-apply-2026-09-21.log (bucket created, public-access block + lifecycle + bucket policy applied; put-bucket-encryption and both iam:PutRolePolicy steps DENIED for `claude-code-aws-agent`, verbatim).

AC-9 — Live, NOT verified at PR time: a staging Operator Console turn calling `dev_index_query` answers with `sha 9545b190…` (or newer, once CODEINTEL-INDEX.yml has run), and a staging executor run shows `runner:code_index` with `nodes>0` and at least one `dev_index_query`/`dev_get_risk` tool call in its steps.
UI: Command Hub → Operator Console on `preview-aws-gateway.vitanaland.com` after this merge deploys staging; steps via `GET /api/v1/dev-autopilot/executions/:id/steps` after the next `autopilot_run_task`. Recorded under outputs/ when done.
