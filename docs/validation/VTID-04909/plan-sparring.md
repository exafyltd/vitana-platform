# VTID-04909 — plan sparring record (shared plan for VTID-04909 code + VTID-04910 draft text)

Canonical plan hash (VTID-04868 `canonical-hash.ts`): `f4af33d30f6b1bb749685526e1e87a9fd24fcd7481762eb80dbe3a42efcdf8dc`. Partner: plan-sparring-partner, converged after 2 rounds (10 findings, all closed). Owner approval: 2026-10-06 ("A. Plan — APPROVED"), with: migration not applied (separate gate, 0/0 precondition), legal text DRAFT / COUNSEL REVIEW, §20 phrase aligned to „aus oder im Zusammenhang mit“, §20.2 court sentence marked FINAL LEGAL COUNSEL CONFIRMATION REQUIRED, formal „Sie“ for acceptance/binding notices, placeholder for the legal-notice contact. The plan block below is verbatim; its `VTID A` / `VTID B` are VTID-04909 / VTID-04910.


Planner: Claude Code session (owner: d.stevanovic@exafy.io). Date: 2026-10-06.

<!-- plan:begin -->
## Context (audited 2026-10-06, origin/main platform b3d9d2ba, v1 6db3b22)
VTID-04895 built the lifecycle with **English binding**, in 7 places:
- DB `supabase/migrations/20261005130000_vtid_04895_partner_terms_lifecycle.sql`: `binding_locale TEXT DEFAULT 'en' CHECK (binding_locale = 'en')`; constraint `partner_terms_versions_binding_text` requires `content->'en'` title+body; `publish_partner_terms_version()` hashes `sha256(utf8(content.en.title || E'\n' || content.en.body_md))`; column comments say English.
- Gateway `services/partner-terms.ts`: `BINDING_LOCALE = 'en'`; `termsForDisplay()` reduces the requested locale to its two-letter base (`pt-BR`→`pt`, `zh-CN`→`zh`), shows the English text plus that translation alongside, `shown_locale` = `en` | `en+xx`.
- Gateway `routes/admin-partner-terms.ts` `parseTermsContent()`: locale keys must match `^[a-z]{2}$` (rejects `pt-BR`, `zh-CN`), requires `content.en`.
- Gateway `routes/partner-onboarding.ts`: `POST /:orgId/terms/accept` requires `shown_locale` to match `^en(\+[a-z]{2})?$`; inserts version id + canonical hash + shown_locale; the DB trigger checks version is published and hash equals the version's hash; unique (org, terms_version_id) → repeat = `already_accepted`; delegated OAuth token → 403 `TERMS_ACCEPTANCE_REQUIRES_SUPPLIER`; admin writes → `REQUIRES_OWN_SESSION`.
- Frontend `src/lib/commerce-terms.ts` + `components/commerce/PartnerTermsSheet.tsx`: English section (`lang="en" dir="ltr"`) + translation section; no language switcher; fetch passes the app locale (`de-DE`, `pt-BR`, `ar-XA`, `zh-CN` …, from `catalogs` in `src/i18n/index.ts`); catalog strings say "Englisch – die verbindliche Fassung".
- RTL: `RTLProvider` sets `documentElement.dir` from the app language (`isRtlLanguage`, base `ar`); the English section forces `dir="ltr"`.
- Existing safe staging fixture mechanism: staging specs mock gateway GETs with `page.route` and a `demo-org` (`vtid-04795/04796/04839` specs) — no DB rows needed.
- Migrations reach the database only by manual `RUN-MIGRATION.yml` dispatch; staging and production share the production Supabase project.
- Company record (ADGM commercial licence extract, 30 Sep 2026, supplied by the owner): EXAFY LTD, ADGM registered number 000006675, Private Company Limited By Shares, registered address DD-16-121-018, Floor 16, Al Khatem Tower, WeWork Hub71, ADGM Square, Al Maryah Island, Abu Dhabi, UAE; registrar: ADGM Registration Authority.

## Owner rules for this work
German (`de`) binding; English second; 11 locales in order de, en, es, sr, fr, pt-BR, ru, pl, ar, zh-CN, tr; fallback selected→German; no published version, no acceptance, no production deploy, no DB migration applied without explicit approval.

## A. Authority model + locales (code) — VTID A
### A1. Migration `2026100612xxxx_vtid_A_partner_terms_german_binding.sql` (written + CI-tested; NOT applied)
Why a schema change is needed: the CHECK `binding_locale = 'en'`, the `content->'en'` constraint and the publish hash would refuse/mis-hash a German-binding version.
- Precondition guard: `RAISE EXCEPTION` unless `partner_terms_versions` has 0 rows of any status and `partner_terms_acceptances` has 0 rows with `terms_version_id` set — the change is only defined for the empty state (owner-reported 0/0; cannot be re-verified now because the database connector is unauthorised, so the migration verifies it itself and fails closed).
- The guard also refuses if any draft row exists at all (nothing is deleted or rewritten; the owner decides if that happens).
- `binding_locale` default `'de'`, CHECK `binding_locale = 'de'`; replace `partner_terms_versions_binding_text` with a constraint on `content->'de'` title+body.
- `publish_partner_terms_version()`: same construction, German substituted: `sha256(convert_to((content->'de'->>'title') || E'\n' || (content->'de'->>'body_md'), 'UTF8'))`. Additionally refuse publishing unless `content->'en'` has title+body (English required as second language) — `PARTNER_TERMS_ENGLISH_MISSING`.
- Comments updated, all of them: the `partner_terms_versions` table comment (German binding), `partner_terms_acceptances.content_sha256` (sha256 of the binding German title + body) and `partner_terms_acceptances.shown_locale` (the BCP-47 key of the language on screen).
- Defence in depth for `shown_locale`: CHECK `shown_locale IN ('de','en','es','sr','fr','pt-BR','ru','pl','ar','zh-CN','tr')` on `partner_terms_acceptances` (replaces nothing; the gateway stays the primary validator; inserts are service-role only). Adding a 12th language later is a migration — accepted.
- No change to acceptances triggers, append-only rule, baseline logic, delegation function.
- SQL CI test `scripts/ci/sql-tests/vtid-04895-partner-terms.test.sql` updated (de-keyed fixtures) + new assertions: missing de → error; hash = German; changing en only leaves the publish hash equal; publish without en refused; guard refuses on non-empty state.

### A2. Gateway
- `partner-terms.ts`: `BINDING_LOCALE = 'de'`; `SUPPORTED_TERMS_LOCALES = ['de','en','es','sr','fr','pt-BR','ru','pl','ar','zh-CN','tr']` (display order).
- `resolveTermsLocale(requested, available)`: normalise `_`→`-`, case-insensitive; exact match on a supported key first (`pt-BR`, `zh-CN`); else base-language match only for keys that are a bare base (`de-DE`→`de`, `ar-XA`→`ar`, `sr-RS`→`sr`, `en-US`→`en` …); `pt`, `pt-PT`, `zh`, `zh-TW` match nothing → German. Never English unless English was selected. Never maps `pt-BR`→`pt` or `zh-CN`→`zh`.
- `termsForDisplay(terms, locale)` returns: `binding_locale:'de'`, `binding` (German text), `locale` (resolved key), `fallback` (true when the request asked for a language that is missing), `text` (title/body of `locale`), `available_locales` (supported keys present, display order), `direction` (`rtl` for `ar`), `content_sha256` (canonical German hash, independent of locale), `shown_locale` = `locale`. Kept for compatibility: `translation` = `text` when locale ≠ de, else null.
- `parseTermsContent()`: keys must be one of the 11 supported keys exactly (BCP-47, case-sensitive canonical form); `de` required (error names German); `en` required (second language); each present locale needs title+body. Contract change documented: two-letter-only regex replaced by the allowlist; `pt`/`zh` are rejected with a message naming `pt-BR`/`zh-CN` (no silent mapping). No versions exist, so no stored data is affected.
- `POST /terms/accept`: `shown_locale` must be one of the current version's `available_locales` (else 400). Acceptance row stores version id + canonical German hash + shown_locale; the hash in the body must equal the version's hash whatever the shown locale. Delegation refusal, `REQUIRES_OWN_SESSION`, idempotent repeat, re-acceptance baseline: unchanged.
- Translation corrections: published versions stay immutable (DB trigger). A translation-only correction is a new version with `requires_reacceptance=false` (editorial: same baseline, acceptances stay valid); its canonical hash is unchanged because German is unchanged, and the version id + shown_locale of each acceptance still identify exactly which translation text was on screen. Any German change that alters legal meaning is published with `requires_reacceptance=true`. Documented in the acceptance doc and module header.
- Tests (jest, gateway): parseTermsContent (de/en required, 11 keys accepted incl. `pt-BR`/`zh-CN`, `pt`/`zh`/`EN`/`xx` rejected); resolveTermsLocale table for every app locale (`de-DE`…`tr-TR`, `ar-XA`) + `pt`, `pt-PT`, `zh`, `zh-TW`, null, `fr-CA`; fallback to German when the selected locale is missing; termsForDisplay hash identical across all locales; accept route: shown_locale validation, hash independent of shown_locale, delegated → 403, repeat → already_accepted (existing tests updated from en to de).

### A3. Frontend (vitana-v1)
- `commerce-terms.ts`: parse the new fields; the defaults that read `'en'` today (`binding_locale ?? 'en'`, `shown_locale` fallback `'en'`, commerce-terms.ts L46/L52) become `'de'`; native language names come from a static map `TERMS_LANGUAGE_NAMES` in `commerce-terms.ts` (Deutsch, English, Español, Srpski, Français, Português (Brasil), Русский, Polski, العربية, 简体中文, Türkçe — endonyms are not translated, so not catalog strings; the i18n lint exemption mechanism is used if the rule flags them), filtered to `available_locales`; `fetchPartnerTerms(orgId, locale)`; `acceptBody` sends `shown_locale` = the language on screen and the canonical hash from the response.
- `PartnerTermsSheet.tsx`: one text at a time in the selected language, default = app language resolved by the gateway (German when no preference / missing); a compact language `Select` (native names, the 11 in owner order, only those in `available_locales`) above the text, secondary to it; switching refetches `?locale=` and does **not** change the version/hash; the tick state is kept (same legal version) and Accept sends the locale on screen at that moment; if the refetch returns a different version or hash, the tick is cleared and the existing "updated" notice shows. Always-visible German-binding notice (catalog string, owner wording) above the text; when the shown text is not German, a "Read the binding German version" link switches to `de`. Text block gets `lang` + `dir` from the response (`rtl` for Arabic; Supplier ID/URLs wrapped in `<bdi>` where the UI interpolates them); readable spacing: the app has no markdown renderer (no react-markdown/remark/marked in package.json) and no dependency is added; a small renderer in `commerce-terms.ts` (`termsBlocks(body_md)`) turns `## ` lines into headings, `a)`-style lines into list items and blank-line-separated text into paragraphs, emitted as React text nodes only (never HTML); scrollable body. If a switch refetch fails, the previous text stays on screen with the load-failed notice; tick state and version are unchanged. Checkbox never pre-ticked, below the text, explanation text under it, Accept disabled until ticked.
- Catalog (`src/i18n/{de,en,es,sr,fr,pt,ru,pl,ar,zh,tr}/screens.json` — the `pt`/`zh` directories hold the `pt-BR`/`zh-CN` catalogs; DE first): `bindingLabel`/`translationLabel` rewritten (German binding), new `bindingNotice` (owner wording, 11 languages), `languageLabel`, `readGerman`, `fallbackNotice`, `agree` = owner checkbox wording, `agreeExplanation` = owner explanation wording. Register: the owner's German wording addresses the user as "Sie"; the repo rule is du-form. Proposal: use the owner's exact legal wording (formal) for `agree`/`agreeExplanation`/`bindingNotice` only, with the i18n register exemption the audit supports, everything else stays du — owner to confirm (see Open decisions).
- Tests (vitest): parse; language switch keeps hash/version, accept body carries the shown locale; checkbox required/disabled; Arabic `dir="rtl"`; fallback rendering; no pre-tick.
- Staging Playwright spec (read-only): `page.route` mocks `partner-orgs/mine`, `partner-onboarding/demo-org`, `/terms?locale=…` with a fixture built from the draft v1 text (marked DRAFT — NOT PUBLISHED); network guard aborts non-GET; never clicks Accept. Screenshots: DE mobile 390×844, DE desktop 1400×900, tablet 820×1180 (above the required minimum — owner asked for tablet/narrow desktop), EN, AR (RTL), SR, ES, switcher open, checkbox unchecked (Accept disabled), checkbox checked (Accept enabled — not clicked).
- What's New: no entry (no member-facing feature until published).

## B. Partner Terms v1 legal text (docs) — VTID B
- `docs/legal/partner-terms/2026-10/de.md` canonical, then en, es, sr, fr, pt-BR, ru, pl, ar, zh-CN, tr translated from the final German. Third-person drafting ("der Partner", "VITANALAND") so no du/Sie conflict inside the text. 21 numbered sections exactly as the owner's structure; owner's wording verbatim for §19 (binding language) and §20 (governing law, UAE / Abu Dhabi courts); §15 and §16 and §20 carry `FINAL LEGAL COUNSEL REVIEW REQUIRED BEFORE PUBLICATION`; no 10%/5% split; no seller/merchant-of-record claim; MCP/API clause limited to scopes the supplier authorises, revocable, AI actions subject to permissions and confirmation; no earnings guarantee.
- Company identification from the ADGM licence (name, ADGM number 000006675, registered address); placeholders only where no authoritative record exists: `[LEGAL NOTICE CONTACT TO CONFIRM]` (no approved legal-notice e-mail/contact found). Flagged for counsel: registration is in ADGM (own courts and common-law framework) while the owner-given §20 names UAE law and the competent courts of Abu Dhabi — wording kept verbatim, not changed, but flagged; "VITANALAND" is a brand, the licence names EXAFY LTD only.
- `docs/legal/partner-terms/2026-10/README.md`: status DRAFT, not published, version `2026-10`, `requires_reacceptance: true`, placeholders list, counsel-review list, how it would later be submitted (admin API, owner's own session) — no script that sends it.
- QA test (gateway jest, reads the docs): all 11 files exist; same section numbers 1–21 in order; same placeholders set in each; the counsel-review marker on §15, §16, §20 in each; §19 present; Arabic file contains no LTR-breaking control characters; each file has a title line; content passes `parseTermsContent` when assembled (de+en+9).

## Rollout order (both repos on staging)
The gateway and the frontend change ship to staging in the same verification cycle: the gateway PR merges first (its old-frontend compatibility fields mean an old frontend shows the German text in the binding section, mislabelled "English" — harmless on staging because no version is published and every staging test uses mocked terms), then the frontend PR; STAGING-VERIFY for community-app runs after both are on staging. With 0 published versions nothing renders in production in between either way, and no production deploy is part of this plan.

## Release gates (unchanged by this plan)
No draft row, no published version, no acceptance, no migration run, no production deploy. After merge: staging deploys + STAGING-VERIFY (both repos); report back. Applying the migration and creating the draft are separate owner approvals.

## Open decisions for the owner
- O-1 register: owner's German acceptance wording uses "Sie"; repo rule is du. Proposal above.
- O-2 ADGM vs "courts of Abu Dhabi" in §20 — kept as instructed, flagged for counsel.
- O-3 legal-notice contact: placeholder unless the owner names one.

## Change class
standard (DB migration file + auth-adjacent acceptance route + legal text).
<!-- plan:end -->


## Planner responses — round 1
- F1 [major] ACCEPTED — the `'en'` defaults in `commerce-terms.ts` (L46 binding_locale, L52 shown_locale) are named change targets, now `'de'`.
- F2 [major] ACCEPTED — rollout order section added: gateway then frontend in one staging verification cycle; window is harmless (nothing published, staging tests mock terms); no prod deploy.
- F3 [major] ACCEPTED — migration updates the acceptance column comments (`content_sha256`, `shown_locale`) as well.
- F4 [minor] ACCEPTED — catalog paths named as the real directories `pt`/`zh`.
- F5 [minor] ACCEPTED — versions table comment included.
- F6 [minor] ACCEPTED — tablet noted as above the minimum.
- F7 [minor] no change needed (agreed).
- F8 [major] ACCEPTED — DB CHECK on `shown_locale` membership added for defence in depth; gateway remains the primary validator.
- F9 [major] no change needed — the resolver test table already covers every app catalog key (`de-DE`…`tr-TR`, `ar-XA`→`ar`); explicitly asserted per key.
- F10 [minor] ACCEPTED — static endonym map in `commerce-terms.ts`, filtered to `available_locales`.
- Q1: the owner's last read reported 0 versions in total (all statuses) and 0 acceptances; the guard now refuses on any row of any status, so a draft would stop it too.
- Q2: switch = refetch; on failure the previous text stays with the load-failed notice; nothing about the tick or version changes.
- Q3: confirmed no markdown renderer exists; a minimal text-node renderer is specified (no dependency, no HTML).

## Round 2 — partner status
F1–F10 closed. No new findings. Questions: none.

## Verdict
CONVERGED after 2 rounds (standard class). Awaiting owner approval.
