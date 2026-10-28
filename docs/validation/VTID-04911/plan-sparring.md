# VTID-04911 — Plan sparring record

- Plan Sparring Gate: VTID-04868. Partner: `plan-sparring-partner` (independent, read-only).
- Change class: standard. Rounds: 2.
- Final plan hash (canonical, plan markers only): `cf9344a3fc2bf09ecd25a024db9e98a67eaed4666915f2b077ac1d9d591d3c93`
- Verdict: **converged** (round 2: all findings closed/acknowledged, no new blocker or major).
- Owner approval: owner message 2026-10-06 "PARTNER TERMS v1 — FINAL APPROVAL, CLEANUP, MIGRATION PREP &
  PRODUCTION RELEASE PLAN" explicitly approves this scope (update §21.1 with legal@vitanaland.com; remove the
  internal legal-review markers; rerun QA; fresh read-only 0/0 check; apply the German-binding migration if and
  only if 0/0; verify it; prepare release candidates). The sparred plan implements exactly that scope and adds
  nothing outside it.

## Final plan

<!-- plan:begin -->
## Context
Owner message 2026-10-06 "PARTNER TERMS v1 — FINAL APPROVAL, CLEANUP, MIGRATION PREP & PRODUCTION RELEASE PLAN":
legal text accepted for v1 as drafted; no external counsel review before v1. Only substantive content change
authorised: §21.1 gets `legal@vitanaland.com` (replacing `[LEGAL NOTICE CONTACT TO CONFIRM]`), and the internal
markers `FINAL LEGAL COUNSEL REVIEW REQUIRED BEFORE PUBLICATION` / `FINAL LEGAL COUNSEL CONFIRMATION REQUIRED`
are removed everywhere. The substantive clause text of §15, §16, §19 and §20 stays unchanged; the internal markers under §15, §16, §20 and above §20.2 are removed (non-substantive cleanup). Clause numbering and hash model unchanged. Not approved: production
deploy, creating the v1 row, publishing, accepting.

Change class: **standard** (13+ files across two repos; includes applying an already-merged migration).

## Scope (files)
vitana-platform:
1. `docs/legal/partner-terms/2026-10/{de,en,es,sr,fr,pt-BR,ru,pl,ar,zh-CN,tr}.md`
   - §21.1: replace the placeholder with `legal@vitanaland.com`, keeping each language's existing punctuation
     (de/en exactly the owner's sentence; fr `" ; "`; zh `；legal@vitanaland.com。`; ar keeps `؛`). The email is
     never translated, no bidi control characters are inserted.
   - Delete the 4 marker lines per file (under `## 15.`, `## 16.`, `## 20.`, and above `20.2`) together with
     the blank line that follows each, so paragraphs stay separated by exactly one blank line. No other
     character changes (verified by a diff that shows only those lines).
2. `docs/legal/partner-terms/2026-10/README.md` — rewritten to the final state: "APPROVED FOR V1 · NOT YET
   PUBLISHED"; counsel-review and placeholder sections removed; notes from drafting kept as non-blocking
   notes; legal notice address and email stated; publication/acceptance still need separate owner approval.
3. `services/gateway/test/vtid-04910-partner-terms-draft-text.test.ts` — assertions flipped to the final
   state: no marker and no `[`…`]` placeholder in any file; `legal@vitanaland.com` exactly once per file and
   inside the `21.1` line; de/en §21.1 equal the owner's sentences verbatim; structure identical to German
   (21 sections, same clauses/letters); §19/§20 owner wording kept; no bidi controls; company details present;
   valid admin content (parseTermsContent) for all 11; README assertions: `/APPROVED FOR V1 · NOT YET PUBLISHED/` and `/nothing is published, nothing is\s+accepted/` (the README keeps that sentence), and the README contains neither marker nor the placeholder.
4. `docs/validation/<NEW-VTID>/` — plan-sparring.md, acceptance.md, commands.log, outputs/, staging-tests.json
   (kind `existing`: the jest file above; the change has no runtime surface, but the test path triggers the
   staging gateway deploy, so a suite is required).
5. `DATABASE_SCHEMA.md` — after the migration is applied and verified: the VTID-04909 row changes from
   "committed, NOT applied" to "applied <date> via RUN-MIGRATION run <id>".

vitana-v1:
6. `tests/e2e/staging/fixtures/partner-terms-2026-10-draft.json` regenerated from the cleaned platform files
   (same build script as before: line 1 = title, rest = body_md). No app code changes; `termsBlocks`' marker
   rendering stays (generic, harmless, tested). The staging spec asserts only the title, `Supplier ID` (ar), lang/dir
   and checkbox/Accept state — none of which change — so it needs no edit; the v1 PR is test-fixture-only (does
   not trigger a deploy) and is covered by the existing VTID-04909 suite at the next staging run, listed again in
   `docs/validation/<NEW-VTID>/staging-tests.json` in vitana-v1.

## Migration (operational, no new code)
7. Fresh read-only check on production Supabase, from this Claude Code session via the Supabase MCP `execute_sql` (SELECT only): `select count(*) from partner_terms_versions` and
   `partner_terms_acceptances`. Not 0/0 → STOP and report.
8. 0/0 → dispatch `RUN-MIGRATION.yml` (main) with
   `migration_file=supabase/migrations/20261006120000_vtid_04909_partner_terms_german_binding.sql`. The
   migration's own DO-block guard re-checks 0/0 inside the transaction and refuses otherwise. No manual SQL.
9. Read-only verification: `pg_get_constraintdef` of `partner_terms_versions_binding_locale_check` (= 'de'),
   `partner_terms_versions_binding_text` (content->'de'), `partner_terms_acceptances_shown_locale_supported`
   (11 codes); column default of `binding_locale` = 'de'; `pg_get_functiondef(publish_partner_terms_version)`
   contains `PARTNER_TERMS_ENGLISH_MISSING` and hashes `content -> 'de'`; grants unchanged
   (`has_function_privilege` anon/authenticated false, service_role true); counts still 0/0. Any mismatch → STOP.

## Order
cleanup PR (platform) + fixture PR (v1) → local QA → CI green → 0/0 → migrate → verify → DATABASE_SCHEMA commit
on the same platform PR → merge both → staging deploy + STAGING-VERIFY → prepare (not execute) production
release candidates for gateway and frontend, with every commit between production and the candidate, the
unrelated commits, rollback targets, workflows, env changes and DB writes. STOP for owner approval.

## Risks
- A stray character change in the legal text: mitigated by a scripted edit + diff limited to the marker and
  §21.1 lines, and the jest structure test.
- Migration on non-empty tables: double-guarded (pre-check + in-migration guard).
- Merging a gateway-path test triggers a staging deploy of current main (which includes other sessions'
  commits) — no behaviour change from this PR; recorded in the release-candidate report.
<!-- plan:end -->

## Round 1 — partner findings (summary of the verbatim report)

- Verified premises: 4 marker lines per file (de.md:147,159,196,200; identical in all 11); placeholder in §21.1
  of all 11 (line 206); fr ` ; `, zh-CN `；…。`, ar `؛` punctuation; RUN-MIGRATION.yml takes `migration_file`;
  DATABASE_SCHEMA.md:1405 row says "committed, NOT applied"; the QA test asserts markers/placeholder (lines
  75–85); the v1 fixture exists.
- F1 [major] README assertion strings in the test not specified.
- F2 [major] "§15, §16, §19, §20 unchanged" grouping could be misread as skipping marker removal.
- F3 [minor] v1 staging spec coverage / staging-tests.json for the v1 PR.
- F4 [minor] channel for the read-only 0/0 pre-check not stated.
- F5 [minor] line-deletion logic — confirmed correct, no change.
- F6 [minor] does the v1 staging spec assert on markers/placeholder?
- Q3: are the "not approved" items a constraint on this plan? 
- Verdict round 1: NOT CONVERGED (F1 major), no blockers.

## Planner responses — round 1

- F1 ACCEPTED — exact README assertion strings named in item 3.
- F2 ACCEPTED — context sentence rephrased.
- F3 ACCEPTED (clarified) — the staging spec asserts title, `Supplier ID`, lang/dir and checkbox/Accept only
  (spec lines 128, 149, 158); none change. The v1 PR also gets docs/validation/VTID-04911/staging-tests.json.
- F4 ACCEPTED — Supabase MCP `execute_sql`, SELECT only.
- F5 ACKNOWLEDGED.
- F6 ACCEPTED — as F3; the cleaned ar.md still contains `Supplier ID`.
- Q3: yes — a constraint on this plan; none of those happen here.

## Round 2 — partner

F1 closed, F2 closed, F3 closed, F4 closed, F5 acknowledged, F6 closed. No new blocker or major findings.
Verdict: **CONVERGED**.
