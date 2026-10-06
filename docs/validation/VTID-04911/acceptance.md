# VTID-04911 — Acceptance

Owner instruction 2026-10-06 ("PARTNER TERMS v1 — FINAL APPROVAL, CLEANUP, MIGRATION PREP & PRODUCTION
RELEASE PLAN"). Sparring: `plan-sparring.md` (converged, plan hash `cf9344a3…3c93`).

## AC-1 — §21.1 names legal@vitanaland.com in all 11 languages
German and English carry the owner's sentences verbatim; the other 9 replace only the placeholder, keeping
their punctuation. The email appears exactly once per file.
TEST: services/gateway/test/vtid-04910-partner-terms-draft-text.test.ts ("names legal@vitanaland.com in §21.1…",
"German and English carry the owner wording for §19, §20 and §21.1"); outputs/multilingual-qa.txt

## AC-2 — no internal marker and no placeholder anywhere
`FINAL LEGAL COUNSEL REVIEW REQUIRED BEFORE PUBLICATION`, `FINAL LEGAL COUNSEL CONFIRMATION REQUIRED` and
`[LEGAL NOTICE CONTACT TO CONFIRM]` are gone from all 11 files and the README; no double blank line is left.
TEST: same jest file; outputs/multilingual-qa.txt

## AC-3 — nothing else changed
Diff of the 11 files is limited to the 4 marker lines (+ their following blank line) and the §21.1 line;
structure identical to German (21 sections, 63 clauses, 31 list items); §19/§20 owner wording kept; files
remain valid admin content (parseTermsContent).
TEST: same jest file; outputs/text-diff.txt

## AC-4 — German-binding migration applied only on 0/0 and verified read-only
Recorded in outputs/migration.md (pre-check, RUN-MIGRATION run id, post-verification).
TEST: SQL-PARTNER-TERMS CI (throwaway Postgres) for the migration's behaviour; read-only catalog checks in
outputs/migration.md for the live result.

Not part of this VTID: production deploy, creating the v1 row, publishing, accepting.

German content hash the v1 version will carry once created/published (same text, informational):
`f70d1427fc2f302233b678ffdcef04225ab65dbbe4148252cb03300f6954a489`.
