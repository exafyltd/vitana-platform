<!--
VTID-05305 — PR body template.

VALIDATOR-CHECK (the `validate-pr` gate) runs on PRs that touch the gateway
trees (services/gateway/src|dist|openapi|test, docs/validation) and demands a
VALIDATION_PROFILE plus the four markers below. This template carries all of
them so a gateway PR passes on the first push instead of failing one marker per
round. A PR that touches none of those trees can delete the "Validator
declarations" block — the gate does not run for it — but leaving it in is
harmless.

Put the VTID in the PR TITLE, e.g.  VTID-05305 (slug/lane): short description
-->

## Summary

<!-- What this PR changes and why, in a sentence or two. -->

## Tests

<!-- The commands you ran and their pass/fail counts; the red→green proof. -->

## Verification

<!--
The checks of each change type this PR touches: .kiro/pipeline/quality-checks.md.
Change types: UI / Backend / Database / Integration / Infrastructure-CI / Tooling-docs.
Say what was observed where: the staging suite and what it asserts about this change,
or "not verified on staging: <reason>" plus the test that covers it. Never write
"verified" for something only unit-tested.
UI: 1400x900 and 390x844 screenshots of the changed element after the interaction,
or why there are none. Backend: the route's auth gate and content type the probe
expects. Database: the kept defaults, grants and policies. Infra/CI: the workflow run.
-->

- Change types:
- Observed:
- Not verified on staging (reason, covering test):

## Validator declarations

<!--
Required by VALIDATOR-CHECK for gateway PRs. Keep every declaration line below
and fill in its value. Do NOT write the marker names (the "WORD:" forms) inside
this comment — VALIDATOR-CHECK extracts the profile and OASIS impact with a
first-match grep, so a sample marker here would be read instead of your real
value. The fields, described without the literal markers:
- the validation profile is one of  command_hub_frontend  or  gateway_backend
- the scope allowlist is the set of path globs this PR may touch
- the acceptance value is the path to docs/validation/<VTID>/acceptance.md
- the merge payload preview is what a merge deploys, or "none" for CI-only
- the OASIS impact is yes or no (yes also needs an OASIS proof in acceptance.md)
If this PR changes a lockfile, add a dependency-change line explaining why.
-->

VALIDATION_PROFILE: gateway_backend
SCOPE_ALLOWLIST: services/gateway/src/**, docs/validation/**
ACCEPTANCE: docs/validation/VTID-XXXXX/acceptance.md
MERGE_PAYLOAD_PREVIEW: none (describe what a merge deploys, or keep "none")
OASIS_IMPACT: no
