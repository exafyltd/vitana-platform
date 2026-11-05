# VTID-05551 acceptance (agentic-delivery/prerequisites)
Change types: Backend, Tooling/docs.
Outcome: the two route files the GitLab lanes add (`routes/internal-gitlab-webhook.ts` of eng-gitlab-m2 lane scm-webhook
and `routes/delivery.ts` of lane gateway-delivery) pass the atlas drift guard when they land, and every STAGING-VERIFY
row in OASIS can say which host verified it, while GitHub's rows stay byte for byte as they are. Nothing changes for
members.

AC-1 `domainsForRoute` of `internal-gitlab-webhook` (with or without `.ts`) returns exactly the domain `deploy`.
TEST: services/gateway/test/atlas-gitlab-route-claims.test.ts "internal-gitlab-webhook belongs to the deploy domain, and only to it"
AC-2 `domainsForRoute` of `delivery` (with or without `.ts`) returns exactly the domain `deploy`.
TEST: atlas-gitlab-route-claims.test.ts "delivery belongs to the deploy domain, and only to it"
AC-3 The claims are anchored exact names (`/^internal-gitlab-webhook$/`, `/^delivery$/`), so no other future route file
is claimed by accident, and the eight existing claims of `deploy` are unchanged; nothing else in `domain-atlas.ts`
changes.
TEST: atlas-gitlab-route-claims.test.ts "the claims are exact names, not prefixes", "the deploy domain keeps its existing claims"
AC-4 The drift guard and the rest of the role-separation suite stay green (CLAUDE.md NEVER 42h).
TEST: services/gateway `npm run test:roles` — 105 passed (outputs/test-roles.txt)
AC-5 `record-oasis.sh` with `WORKFLOW` unset or empty sends a body byte-identical to today's for the same
`results.json`, with `metadata.workflow: "STAGING-VERIFY.yml"`; GitHub's STAGING-VERIFY.yml sets no `WORKFLOW`.
TEST: scripts/ci/staging-verify/record-oasis-workflow.test.mjs "WORKFLOW unset: the body is byte-identical to today's", "WORKFLOW empty: treated as unset…"
AC-6 With `WORKFLOW=gitlab:vitana/vitana-v1/staging-verify` the body differs from today's only in `metadata.workflow`.
TEST: record-oasis-workflow.test.mjs "WORKFLOW set: the body differs from today's only in metadata.workflow"
AC-7 The crashed-runner body follows the same rule (unset: today's bytes; set: only `metadata.workflow` differs).
TEST: record-oasis-workflow.test.mjs "crashed runner, WORKFLOW unset…", "crashed runner, WORKFLOW set…"
AC-8 `WORKFLOW` reaches jq as data (`--arg`), so quotes or backslashes in it stay one JSON string and add no key.
TEST: record-oasis-workflow.test.mjs "WORKFLOW is passed as data: quotes and backslashes stay one JSON string"
AC-9 Every existing behaviour of `record-oasis.sh` is unchanged (body from a file, 128 KiB+ runs, superseded fields,
missing credentials, failed POST, temp file removed, the workflow step).
TEST: scripts/ci/staging-verify/record-oasis.test.cjs — 9 passed; all staging-verify script tests 94 passed (outputs/staging-verify-scripts.txt)

OASIS_PROOF: `record-oasis.sh` is the only writer changed. With `WORKFLOW` unset (every GitHub run) it writes the same
`oasis_events` row as today, byte for byte (AC-5, AC-7: the test compares the exact bytes today's script sends for the
same fixture). With `WORKFLOW` set it writes the same row with only `metadata.workflow` changed (AC-6). The PUBLISH gate
selects rows by topic, `metadata->>service` and `metadata->>commit`
(`services/gateway/src/services/testing/publish-gate.ts:135-137`) and reads results and `run_url` (`:56-66`), never
`workflow`; no gateway code reads `metadata.workflow` of a `staging.verify.*` row. No row is written by this PR: the
script runs only inside STAGING-VERIFY, and its tests use a fake `curl`.

States: `WORKFLOW` unset or empty (today's value `STAGING-VERIFY.yml`); set (that value); the crashed-runner path (the
same rule).
Surfaces: callers of `domainsForRoute` (the developer assistant's deep dive and atlas tools) see two more names under
`deploy`; the drift test; the STAGING-VERIFY workflow (its inputs are unchanged); readers of `oasis_events`
`staging.verify.*`.
Locales: n/a. Accessibility: n/a.
Contract: the atlas entry shape of `domain-atlas.ts` is unchanged; the `record-oasis.sh` environment of its header plus
the optional `WORKFLOW`.
Staging proof: `docs/validation/VTID-05551/staging-tests.json` — the gateway build with the new claims answers `/alive`
200, plus the atlas test and the role-separation suite as an `existing` test. The atlas has no read endpoint, so the
claims are not otherwise observable on staging; the drift test covers them. `record-oasis.sh` deploys nothing; its next
real run is the next STAGING-VERIFY on GitHub, which records the same body as before.

Red on base: outputs/red-on-base-atlas.txt (2 of 4 fail: neither name is claimed on base; the two guard tests pass on
base by design) and outputs/red-on-base-record-oasis.txt (the 3 `WORKFLOW`-set cases fail on base; the 3 unset cases
pass, which proves the expected bytes are today's). Green: outputs/green-atlas.txt, outputs/green-record-oasis.txt.

Decisions taken inside the plan (for Gate 2):
- An empty `WORKFLOW` counts as unset (`${WORKFLOW:-STAGING-VERIFY.yml}`), so a pipeline that sets the variable to an
  empty value can never record an empty workflow name.
- The header comment of `record-oasis.sh` names the new optional variable; the jq programs change only in
  `workflow: $wf`.
