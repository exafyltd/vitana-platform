# VTID-05080 — standing VTID for the automated screens-catalog sync; one rolling PR that can run checks and merge

Owner decision 2026-10-12 ("Yes, approved. Go ahead." at Gate 1 on the sparred plan, decisions D1-D3 at the recommended defaults). Sparring: `plan-sparring.md` (standard class, 3 rounds, escalated at the cap, all findings answered).

**This VTID is STANDING and never terminal.** It is named in the title of every bot PR from REGEN-SCREENS-CATALOG, so every such PR touches a gateway deploy path with a VTID and a change suite. `VTID_AUTO_CLOSE: no` is set on this PR and on every bot PR.

Problem (verified in code and history): the workflow opened a new timestamped PR for every run and none could merge: the title had no VTID (STAGING-TESTS-REQUIRED), PRs made with the default token start no checks, VALIDATOR-CHECK needs body markers, and `last_synced` made almost every run produce a date-only diff. Only one such PR ever merged (#998, 2026-04-30); eight were closed unmerged.

VALIDATION_PROFILE: gateway_backend

ROUTE_MOUNT: not applicable. No gateway route changes; the change is a CI workflow, a CI helper script, and the regen script's date handling.

FINAL_URL: https://preview-aws-gateway.vitanaland.com/command-hub/navigation-config.js (staging, read-only GET).

OASIS_PROOF: not applicable. No state transition or decision is added; no event is emitted by design.

CURL_PROOF: after the staging deploy, `GET /command-hub/navigation-config.js` returns 200. The workflow itself is proved on the first real bot PR after merge (see Limits).

## Acceptance criteria

AC-1: A date-only difference is "no change": the regen script keeps the existing `last_synced` unless something else differs, `--check` passes on it, and a real difference regenerates AND stamps today.
  TEST: services/gateway/test/vtid-05080-regen-screens-catalog-date.test.ts
AC-2: One stable branch and one open PR: the first publish creates the branch and exactly one PR (title carries the standing VTID, body carries every VALIDATOR-CHECK marker and `VTID_AUTO_CLOSE: no`, auto-merge requested); a later publish moves the branch head without a second PR; after a merge a new PR opens; a failed PR listing or auto-merge is a warning.
  TEST: services/gateway/test/vtid-05080-regen-screens-catalog-pr.test.ts
AC-3: A missing `SCREENS_CATALOG_PR_TOKEN` fails the publish step loudly before anything is pushed or created; the no-diff cleanup needs no PAT.
  TEST: services/gateway/test/vtid-05080-regen-screens-catalog-pr.test.ts
AC-4: A rolling PR left over when a later run finds no diff is closed with a comment and its branch deleted; with nothing open nothing is closed.
  TEST: services/gateway/test/vtid-05080-regen-screens-catalog-pr.test.ts
AC-5: A branch that moved underneath a run is never silently overwritten (the push uses a lease on the ls-remote sha, empty when the branch is absent).
  TEST: services/gateway/test/vtid-05080-regen-screens-catalog-pr.test.ts
AC-6: The committed catalog is in sync with main's own sources (opt-in: `npm run test:screens-catalog-sync`; the workflow runs the same `--check` before it pushes), and the generated spec is well-formed.
  TEST: services/gateway/test/vtid-05080-regen-screens-catalog-check.test.ts
  TEST: services/gateway/test/vtid-05080-dev-frontend-spec-valid.test.ts
AC-7: The existing catalog suite stays green (no retired Overview tab ids in the inventory or navigation config).
  TEST: services/gateway/test/vtid-04986-screen-inventory-in-sync.test.ts

## Owner decisions taken (Gate 1)
D1 bot PRs auto-merge under the standing VTID; D2 the `SCREENS_CATALOG_PR_TOKEN` secret must exist (see Limits); D3 a standing, never-terminal VTID for automated catalog syncs.

## Limits and what is NOT proven
- Branch protection and the list of required checks cannot be read from a session. B1 (title VTID, change suite), B2 (checks start with the PAT) and B3 (VALIDATOR-CHECK) are proved on the first real bot PR after merge: one open PR on `auto/screens-catalog`, check runs on its head, STAGING-TESTS-REQUIRED and VALIDATOR-CHECK green, a later trigger moves its head without a second PR, and with auto-merge on it merges and the following STAGING-VERIFY passes. Until then they are covered by the local tests and the validator scripts.
- **The repository secret `SCREENS_CATALOG_PR_TOKEN` is not visible to a session.** If it does not exist, the first catalog change makes the publish step fail loudly (red workflow run, no PR) instead of opening a PR that can never merge. The owner must create a fine-grained PAT or app token with contents and pull-requests write and store it under that name.
- The default gateway CI does not run the sync check (opt-in), so ordinary PRs that edit Command Hub navigation are not blocked by it.
