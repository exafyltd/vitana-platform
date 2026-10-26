# Design — spotlight-commit-coverage
Detail: `plan.md`. The vitana-v1 `docs/validation/commit-coverage.json` file maps each merge's full sha to its lane
VTID. Seven new `staging-tests.json` files (kind `existing`) give the VTIDs that lack one a suite of tests that
already exist. STAGING-VERIFY reads both from the commit under test (`--repo-root target`).
