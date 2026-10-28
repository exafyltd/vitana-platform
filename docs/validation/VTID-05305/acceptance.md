# VTID-05305 — false-positives-validator

Make the `VALIDATION_PROFILE` round-trip a template / autofill / clear early
failure. Plan: `.kiro/specs/ci-github-modernization/`, lane
`false-positives-validator`.

## What changed

1. **PR body template** — `.github/pull_request_template.md` carries
   `VALIDATION_PROFILE` and the four required markers (`SCOPE_ALLOWLIST`,
   `ACCEPTANCE`, `MERGE_PAYLOAD_PREVIEW`, `OASIS_IMPACT`) with guidance, so a
   gateway PR opened from the template already satisfies the gate.
2. **Early, actionable failure** — a new `prBodyRequirements(body)` in
   `scripts/ci/validator-path-guard.cjs` (CLI `--pr-body-check`) checks all five
   declarations at once and prints every missing one with the exact line to add.
   `VALIDATOR-CHECK.yml` runs it as the "Require PR body declarations" step right
   after collecting the PR text, replacing the bare `exit 11` and the separate
   inline "Require PR markers" step (exit 12-15). Exit codes are unchanged — the
   first missing item's historic code (11/12/13/14/15) — so the documented
   downstream contract is preserved.

## Why

The `VALIDATION_PROFILE` line alone cost almost every lane in this plan a review
round: a PR opened without the template failed on the first missing marker with
no hint of the others, so each push only surfaced the next missing line. One
consolidated message + a template ends that round-trip.

AC-1 VALIDATION_PROFILE round-trip is a template + clear early failure
  TEST: node --test scripts/ci/validator-path-guard.test.cjs

AC-2 A PR body from the template passes; a missing-profile PR fails with the
     new clear message naming the missing markers and their fixes
  TEST: node scripts/ci/validator-path-guard.cjs --pr-body-check <body>

AC-3 The guard test case is red on base (bare exit) and green on head
  TEST: see outputs/red-on-base.txt (base) and outputs/green-on-head.txt (head)

AC-4 The trigger stays path-scoped to the gateway trees (no new PR types bitten)
  TEST: REMIT == VALIDATOR-CHECK.yml paths: (outputs/remit-parity.txt)

AC-5 (review round 1) The SHIPPED template survives VALIDATOR-CHECK's own
     first-match extractors: a PR opened straight from it reads
     VALIDATION_PROFILE=gateway_backend and OASIS_IMPACT=no (not a sample marker
     left in the guidance comment). Red on the reviewed template
     (PROFILE=one -> exit 21, IMPACT=yes -> exit 81).
  TEST: node --test scripts/ci/validator-path-guard.test.cjs (3 template cases)
        proof: outputs/template-extractor-fix.txt

OASIS_IMPACT: no
