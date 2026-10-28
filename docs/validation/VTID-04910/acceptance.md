# VTID-04910 — Partner Terms v1 (`2026-10`): draft legal text, 11 languages

Draft only — DRAFT / COUNSEL REVIEW, not publication-approved. `docs/legal/partner-terms/2026-10/` holds the German canonical text and the 10 translations made from it, plus a README with the review gates. Nothing is created, published or accepted.

VALIDATION_PROFILE: gateway_backend

ROUTE_MOUNT: none (documentation + a test).

FINAL_URL: n/a (no runtime surface; the text reaches users only after a separately approved draft + publish).

CURL_PROOF: n/a — the text is not served by any endpoint until published; STAGING-VERIFY runs the QA test (docs/validation/VTID-04910/staging-tests.json).

OASIS_PROOF: n/a (no state change).

## Acceptance criteria

AC-1: German canonical text with the owner's 21-section structure; §15, §16, §20 marked FINAL LEGAL COUNSEL REVIEW REQUIRED BEFORE PUBLICATION; the §20.2 court sentence marked FINAL LEGAL COUNSEL CONFIRMATION REQUIRED (ADGM Courts vs onshore Abu Dhabi courts, exclusive or not — not chosen); §20 scope „aus oder im Zusammenhang mit“ aligned with the English; §21.1 placeholder `[LEGAL NOTICE CONTACT TO CONFIRM]`; company details only from the ADGM licence.
  TEST: services/gateway/test/vtid-04910-partner-terms-draft-text.test.ts
AC-2: All 10 translations keep the German structure exactly (sections, 63 clauses, list letters), markers, placeholder and identifiers; the owner's §19/§20 English wording verbatim; no bidi control characters (Arabic).
  TEST: services/gateway/test/vtid-04910-partner-terms-draft-text.test.ts
AC-3: The 11 files form valid admin content under VTID-04909 (German binding, English present, exact codes).
  TEST: services/gateway/test/vtid-04910-partner-terms-draft-text.test.ts
