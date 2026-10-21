# VTID-04245 — Manual bump of the three npm-audit flagged gateway dependencies

## Why this is a hand-off, not an agent PR

The Dev Autopilot `npm-audit-scanner-v1` finding (`CVE: package.json`) was
auto-approved four times on 2026-09-21 (VTID-04237). Attempts 1–3 exhausted
`AGENT_MAX_TURNS=120` reading `pnpm-lock.yaml` (≈5.5 M input tokens each):
the agent's `run_check` surface offers tsc/jest/git only — no package manager —
so it cannot regenerate a lockfile. Attempt 4 held at `awaiting_approval` with
a hand-off asking for the manual bump; the owner approved it (PR #3543), which
then failed `validate-pr` on exit 10 for the reason VTID-04246 fixes. The owner
agreed ("I agree") that the bump itself is done by hand in this PR.

## Change

| Package | Before | Declared now | Resolved (both lockfiles) |
|---|---|---|---|
| `express-rate-limit` (direct) | `^7.x` | `^8.2.2` | 8.7.0 |
| `@modelcontextprotocol/sdk` (direct) | `^0.x` | `^1.24.0` | 1.30.0 |
| `@grpc/grpc-js` (transitive) | unpinned | `overrides` + `pnpm.overrides` `>=1.14.4` | 1.14.5 |

Both `services/gateway/package-lock.json` (Docker `npm install`) and
`services/gateway/pnpm-lock.yaml` (CI / dev) were regenerated with the
tooling, never by hand. `DEPENDENCY_CHANGE:` is declared in the PR body per
VTID-03696's lockfile rule.

## Acceptance criteria

AC-1 `package.json` declares `express-rate-limit` at `^8.2.2` or later and `@modelcontextprotocol/sdk` at `^1.24.0` or later.
TEST: services/gateway/test/vtid-04245-dependency-floors.test.ts

AC-2 `@grpc/grpc-js` is forced to `>=1.14.4` for BOTH package managers — `overrides` (npm, the Docker image) and `pnpm.overrides` (CI/dev) — so neither install path can resolve a vulnerable transitive.
TEST: services/gateway/test/vtid-04245-dependency-floors.test.ts

AC-3 Both lockfiles resolve every occurrence of the three packages at or above its floor.
TEST: services/gateway/test/vtid-04245-dependency-floors.test.ts

AC-4 The MCP SDK 0.x → 1.x major cannot break runtime code: no file under `services/gateway/src` imports it.
TEST: services/gateway/test/vtid-04245-dependency-floors.test.ts

AC-5 The routes that consume `express-rate-limit` (`live.ts`, `creators.ts`, `orb-live.ts`) and the rate-limit isolation suites still pass against the installed 8.x.
TEST: services/gateway/test/voice-send-chat-rate-limit-isolation.test.ts
TEST: services/gateway/test/console-task-02-onramp-rate-limit.test.ts
TEST: services/gateway/test/orb/live/characterization/tts-pcm-diagnostic-route.characterization.test.ts

AC-6 `tsc --noEmit` is clean against the new installed set.
TEST: services/gateway/test/vtid-04245-dependency-floors.test.ts

## OASIS

OASIS_PROOF: not applicable — no OASIS event, topic or ledger write changes; this PR touches `package.json` and the two lockfiles only. The `npm-audit-scanner-v1` finding is expected to stop re-surfacing on the next `DEV-AUTOPILOT.yml` scan after this merges (the scanner reads `package.json`), which is the live signal.

## Results

| AC | Result |
|---|---|
| AC-1 | MET — 2 tests |
| AC-2 | MET — 1 test (both override keys) |
| AC-3 | MET — 6 tests (3 packages × 2 lockfiles) |
| AC-4 | MET — source walk finds 0 imports |
| AC-5 | see `commands.log` / `outputs/route-suites.txt` |
| AC-6 | see `commands.log` |

## Not done here

- The finding itself (`autopilot_recommendations`, scanner `npm-audit-scanner-v1`) is left for the scanner to close on its next run rather than hand-edited.
- `npm audit` was not run from this session (sandbox registry returns 403 on the advisory endpoint); the floors are the ones the scanner's own finding named.
