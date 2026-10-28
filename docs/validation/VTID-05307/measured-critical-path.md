# VTID-05307 — speed-path-filters: measured before/after critical path

Lane: `ci-github-modernization/speed-path-filters`. Scope: caching, path filters on **non-gate**
jobs only, de-dup, and confirming the gateway Jest 4-shard setup. Target: ≤ 15 min on a typical
gateway PR. This change is **YAML-config only** (dependency caching) plus its proof test; it changes
no test logic, no shard count, and does not flip `PR-GATE` `enforce`.

## Ground-truth test counts (owner, 2026-10-21 — supersede the brief's stale "~7.5k / 4 shards")

| Repo / package | Runner | Suites | Tests (approx.) |
|---|---|---|---|
| vitana-platform → services/gateway | jest | 1,737 | ~22,700 |
| vitana-platform → services/vcaop | jest | 45 | ~290 |
| vitana-platform → services/vcaop-mcp | jest | 7 | ~58 |
| vitana-v1 → web (src/) | vitest | 444 | ~2,840 |
| vitana-v1 → apps/mobile | jest | 61 | ~650 |
| **Total** | | **~2,290** | **~26,500** |

The gateway suite (~1,737 suites / ~22,700 tests) runs in CI as a **4-shard matrix**
(`TEST-SUITE.yml` `gateway` job, `strategy.matrix.shard: [1, 2, 3, 4]`,
`npx jest … --maxWorkers=100% --shard=N/4`), landed by VTID-05272. `gateway-shard-union` proves the
four shards together ran exactly `npx jest --listTests` (nothing missing, nothing twice). This lane
keeps that layout (acceptance: *the gateway suite stays a 4-shard matrix, not collapsed to one job*).

## Shard balance decision

The shards are split by Jest's own `--shard=N/4` over the full `--listTests` set, so Jest balances by
file, not by hand-assigned lists. There is **no hand-maintained shard assignment** to re-balance in
`TEST-SUITE.yml`; a measured imbalance would be addressed by changing the shard **count**, which the
acceptance forbids collapsing and which the ground-truth count (~1,737 suites across 4 shards ≈ ~434
suites/shard) does not warrant. **Decision:** keep 4 shards, change nothing in the shard split. The
only speed change is dependency caching (below).

## Before → after critical path (what changed and the expected effect)

The PR check wall-clock for a typical gateway PR is dominated by **dependency install** repeated
across jobs with cold caches, then the 4 parallel gateway shards. The change adds `setup-node`
dependency caching so repeat runs reuse a warm store instead of re-resolving/re-downloading.

| Job (install step) | Before | After |
|---|---|---|
| `TEST-SUITE` `gateway` (×4 shards) | `pnpm install --frozen-lockfile`, **no cache** → each shard cold-installs the root pnpm workspace | `setup-node` `cache: pnpm`, `cache-dependency-path: pnpm-lock.yaml` → shards restore a warm pnpm store |
| `TEST-SUITE` `services` (vcaop, oasis-projector) | `npm install` / `npm ci`, **no cache** | per-matrix `cache: npm` + `cache-dependency-path: services/<svc>/package-lock.json` |
| `TEST-SUITE` `services` (openclaw-bridge) | `pnpm install --frozen-lockfile`, **no cache** | per-matrix `cache: pnpm` + `cache-dependency-path: services/openclaw-bridge/pnpm-lock.yaml` |
| `PR-GATE` `pr-gate` (conditional gateway `npm ci` on a fix VTID) | `setup-node`, **no cache** | `cache: npm`, `cache-dependency-path: services/gateway/package-lock.json` |

Expected effect: on a warm cache, the install step on the gateway shards drops from a full cold
resolve/download to a cache restore (typically minutes → tens of seconds per shard). Because the four
shards run in parallel, the gateway critical path is `max(shard install + shard jest)`; cutting the
install portion keeps the gateway PR comfortably inside the ≤ 15 min target. The exact seconds are
observed on CI after merge (GitHub Actions cache is populated on the first run on `main`); this
artifact records the mechanism and the expectation, not a fabricated timing.

## Path filters on gate jobs — deliberately NOT added (acceptance guardrail)

`PR-GATE` / `Lane scope` / `Collab handoff` are required merge gates. A `paths:` filter that makes a
required check **not run** on a PR leaves the check pending forever and wedges the Project Manager
merge (inv-code §5). So this lane adds **no** path filter to those jobs. `TEST-SUITE` already carries
its own `paths:` filter (`services/**`, the workflow file, `scripts/ci/test-suite/**`) and is not a
required gate; it is left as-is. No non-gate job in this lane's file scope lacked a needed path filter.

## Coverage gap recorded for the ci-health lane (T3)

No required check runs these today — a standing gap the `ci-health` lane (VTID-05301) surfaces:

- **Playwright / e2e specs** — the owner's ground-truth figure is ~50; a local scan of `e2e/` found
  34 spec-like files (plus others outside `e2e/`). None are run by a required check.
- **Shell / Python test scripts** in `vitana-platform` — a local scan of `scripts/` found 41
  shell/python test-ish files. They use different runners and are not in any required check.

## Files changed by this lane

- `.github/workflows/TEST-SUITE.yml` — dependency caching on the gateway shards and the services
  matrix (no shard-count change, no new path filter).
- `.github/workflows/PR-GATE.yml` — npm caching on the `pr-gate` job's `setup-node` (gate still runs
  on every `pull_request`, no path filter, `enforce` untouched). **Protected gate file** — merge
  needs an owner instruction naming this plan (surfaced for Gate 2).
- `scripts/ci/test-suite/shard-union.test.mjs` — two assertions pinning the caching contract and the
  surviving 4-shard matrix / unfiltered gate (red on base, green on head).

## Deferred for Gate 2

- **`enforce: true` flip of PR-GATE** — a behaviour change for every PR and itself a protected-gate
  edit. **Not** done here; listed for Gate 2 (plan R5).
- **Protected-gate merge** — `PR-GATE.yml` is a protected gate file and `CLAUDE_AVAILABLE=false`, so
  this lane's merge is blocked on an owner instruction naming the plan.
