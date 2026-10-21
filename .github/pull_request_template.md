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

## Validator declarations

<!--
Required by VALIDATOR-CHECK for gateway PRs. Keep every line; fill in the values.
- VALIDATION_PROFILE: one of  command_hub_frontend | gateway_backend
- SCOPE_ALLOWLIST:    the path globs this PR is allowed to touch
- ACCEPTANCE:         path to docs/validation/<VTID>/acceptance.md
- MERGE_PAYLOAD_PREVIEW: what a merge deploys, or "none" for a CI-only change
- OASIS_IMPACT:       yes | no  (yes also needs OASIS_PROOF: in acceptance.md)
Add  DEPENDENCY_CHANGE: <why>  as well if this PR changes a lockfile.
-->

VALIDATION_PROFILE: gateway_backend
SCOPE_ALLOWLIST: services/gateway/src/**, docs/validation/**
ACCEPTANCE: docs/validation/VTID-XXXXX/acceptance.md
MERGE_PAYLOAD_PREVIEW: none (describe what a merge deploys, or keep "none")
OASIS_IMPACT: no
