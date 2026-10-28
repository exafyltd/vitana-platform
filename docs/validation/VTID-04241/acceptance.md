# VTID-04241 — CODEINTEL-INDEX: queue builds, never cancel the one in flight

`.github/workflows/CODEINTEL-INDEX.yml` ran under `concurrency: { group:
codeintel-index, cancel-in-progress: true }`. A full build (graphify +
repowise for both repos) takes ~12 min; when merges land faster than that
every run is cancelled by the next push and `latest/` never advances.
Observed 2026-09-21 while verifying VTID-04229 live: runs 3, 4 and 5
(`c815249`, `7e57461`, `636f105`) all `cancelled`, `latest/manifest.json`
still on run 2's `d7849e6`, the executor and the Operator Console serving a
bundle three merges stale (`docs/validation/VTID-04229/acceptance.md`,
"Verified live").

Fix: `cancel-in-progress: false`. The group still serialises runs (one
`latest/` writer at a time); GitHub keeps one running and one pending run
per group and supersedes older *pending* runs with the newest push, so the
newest sha is always the one built next and a build is never killed
mid-flight.

VALIDATION_PROFILE: gateway_backend

## Acceptance Criteria

AC-1 — The workflow keeps one concurrency group (`codeintel-index`) and sets `cancel-in-progress: false`.
TEST: services/gateway/test/vtid-04241-codeintel-index-queues.test.ts

AC-2 — The reason is recorded next to the setting (the 2026-09-21 cancelled runs), so it is not flipped back for tidiness.
TEST: services/gateway/test/vtid-04241-codeintel-index-queues.test.ts

AC-3 — Live: after the next burst of merges to `main`, `s3://vitana-code-index/exafyltd/vitana-platform/latest/manifest.json` carries the newest merged sha once its run completes, and no CODEINTEL-INDEX run ends `cancelled` mid-build.
TEST: outputs/ — recorded after merge; NOT verified at PR time.

OASIS_PROOF: not applicable — a workflow concurrency setting; no event, no schema.
