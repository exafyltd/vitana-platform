# VTID-04911 — Partner Terms v1 final text + apply the VTID-04909 German-binding migration

Owner instruction 2026-10-06 ("PARTNER TERMS v1 — FINAL APPROVAL, CLEANUP, MIGRATION PREP & PRODUCTION RELEASE
PLAN"). Sparring: `plan-sparring.md` (converged, plan hash `cf9344a3fc2bf09ecd25a024db9e98a67eaed4666915f2b077ac1d9d591d3c93`).
Not part of this VTID: production deploy, creating the v1 row, publishing, accepting.

VALIDATION_PROFILE: gateway_backend

ROUTE_MOUNT: none (documentation + a test).

FINAL_URL: n/a (no runtime surface; the text reaches users only after a separately approved draft + publish).

CURL_PROOF: n/a — the text is not served by any endpoint until published; STAGING-VERIFY runs the QA test (docs/validation/VTID-04911/staging-tests.json).

OASIS_PROOF: n/a (no state change).

## Acceptance criteria

AC-1: §21.1 names legal@vitanaland.com in all 11 languages; German and English are the owner's sentences verbatim; the email appears exactly once per file and is never translated.
  TEST: services/gateway/test/vtid-04910-partner-terms-draft-text.test.ts
AC-2: No FINAL LEGAL COUNSEL marker and no `[…]` placeholder remains in the 11 files or the README; no double blank line is left where a marker was.
  TEST: services/gateway/test/vtid-04910-partner-terms-draft-text.test.ts
AC-3: Nothing else changed — structure identical to German (21 sections, 63 clauses, 31 list items), §19/§20 owner wording kept, the 11 files remain valid admin content; the text diff is limited to marker lines and §21.1 (outputs/text-diff.txt, outputs/multilingual-qa.txt).
  TEST: services/gateway/test/vtid-04910-partner-terms-draft-text.test.ts
AC-4: The VTID-04909 migration was applied only after a fresh 0/0 check and verified read-only (outputs/migration.md); its behaviour, including the empty-table guard, is proven on a throwaway Postgres.
  TEST: scripts/ci/sql-tests/run-partner-terms-test.sh (CI SQL-PARTNER-TERMS)

German content hash the v1 version will carry once created/published (informational):
`f70d1427fc2f302233b678ffdcef04225ab65dbbe4148252cb03300f6954a489`.
