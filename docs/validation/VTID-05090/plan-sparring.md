# Plan sparring record — VTID-05090 (Health Hub D9, gateway)

- **Parent program:** VTID-05020 (Health Hub plan r7, §1 D9).
- **Sparring session:** `plan_sparring_sessions.id = af3c3abc-dfa0-40dd-81a0-301958c44868`, shared with VTID-05091 (the vitana-v1 half). The VTID was allocated with `p_sparring_id`.
- **Partner:** `plan-sparring-partner` agent (read-only, independent). **Rounds:** 2. **Verdict:** CONVERGED.
- **Plan hashes:** round 1 `29be44f8c0dedc4a81b1695a103a4cdc234f0c1a9ba39e5813f47884e77aca2a`, **final `0f57aa37c0ed2a9b21f73ed3463a27913fd4919aa216cd4d4bcdadb9a53314e5`**.
- **Owner approval:** d.stevanovic@exafy.io in the Claude Code session, 2026-10-12 — "Yes approved" (Gate 1 for D6a, D9 and D10).
- **Owner input still open:** the DE + EN AVV text, binding language, click-to-sign acceptability, who may sign, re-sign policy, retention. The feature ships without legal text: the `dpa` step shows `dpa_not_published` until a version is published through the admin API.

## Round 1 — NOT CONVERGED

| # | Sev | Finding | Answer |
|---|-----|---------|--------|
| F1 | major | `admin-partner-dpa.ts` is not claimed by the domain atlas; the VTID-04560 drift guard fails the build. | Accepted: `domain-atlas.ts` in scope; commerce claims `/^admin-partner-dpa$/` and `partner_dpa_versions`. |
| F2 | minor | Line references off by ~8 lines. | Accepted, corrected. |
| F3 | minor | `signer_email` should be NOT NULL. | Accepted. |
| F4 | minor | The `terms_not_published` `nextAction` fix is a sibling fix. | Accepted: kept and named in the PR description. |
| F5 | minor | `domain-atlas.ts` missing from scope. | Accepted (same as F1). |
| F6 | minor | DPA reads must not be able to fail the whole checklist via `Promise.all`. | Accepted: own try/catch before the `Promise.all`. |

## Round 2 — CONVERGED

No findings.

## Implementation decisions (recorded for Gate 2)

1. A sign request from an account without an email answers 403 `ACCOUNT_EMAIL_REQUIRED` (reusing `/start`'s code), because `signer_email` is NOT NULL.
2. The new `ChecklistInput` fields are optional, so existing callers stay valid.
3. DPA tables are read only for partner types that require a DPA; other types show `not_required` with no `missing` code.
4. A trigger refusal `PARTNER_DPA_VERSION_UNKNOWN` also maps to 409 `DPA_CONTENT_MISMATCH`.
5. The existing SQL runner was extended instead of adding a separate DPA runner (the plan allowed either).
6. Out of scope, recorded as follow-ups: `shapeStatus` still attaches the portal link to an unpublished `dpa` step (only `nextAction` changed); the generated Aurora cutover snapshots do not yet include the two new tables.

## Final plan

<!-- plan:begin -->

## Meta
- **Change class:** standard (new tables + routes + UI; one migration applied only after owner approval).
- **Program:** VTID-05020 Health Hub, defect D9, phase 0L. Unblocks phase 5 ("Labs & providers … depends on 0L AVV").
- **Repos / scope:**
  - vitana-platform: `supabase/migrations/<ts>_vtid_<D9>_partner_dpa.sql` (new);
    `services/gateway/src/services/partner-dpa.ts` (new);
    `services/gateway/src/services/partner-terms.ts` (export reuse only, no behaviour change);
    `services/gateway/src/routes/partner-onboarding.ts`; `services/gateway/src/routes/admin-partner-dpa.ts` (new);
    `services/gateway/src/index.ts` (one mount); `services/gateway/src/orb/developer/domain-atlas.ts` (commerce domain claims `/^admin-partner-dpa$/` and table `partner_dpa_versions`, round-1 F1/F5; the VTID-04560 drift guard `test/vtid-04560-role-separation-regression.test.ts:524-528` fails otherwise); `services/gateway/src/services/partner-onboarding-checklist.ts`;
    `services/gateway/src/services/commerce-mcp.ts`; `scripts/ci/sql-tests/` and `.github/workflows/SQL-PARTNER-TERMS.yml`
    (paths + asserts); tests; `DATABASE_SCHEMA.md`; `docs/validation/<VTID>/`.
  - vitana-v1: `src/lib/commerce-dpa.ts` (new); `src/components/commerce/PartnerDpaSheet.tsx` (new);
    `src/components/commerce/SetupHub.tsx`; `src/i18n/<11 locales>/screens.json` (`screens.commerceportal.dpa.*`);
    `docs/SCREEN_INVENTORY.md` (regenerated).
- **Regulatory impact:** this records a GDPR Art. 28 agreement. The code draws no legal conclusions. The text, the binding
  language, the declaration wording and whether this signature form is enough are all owner/legal inputs (Open questions).
- **Rules honoured:** §13c-infra rule 1 (keyed to `partner_organizations.id`), rule 2 (no approved boolean; the step is
  derived from a record), rule 3 (only the supplier's own session signs; an AI assistant never does), rule 7 (no legal
  text or conclusions in code). Also: staging read-only, writes proven in Jest/Vitest/throwaway Postgres, migration only
  through `RUN-MIGRATION.yml` after production approval, OASIS events on state changes.

## Facts (file:line)
Platform (`services/gateway/src` unless stated):
1. **Step defined.** `services/partner-onboarding-checklist.ts:29` lists `dpa` in `STEP_KEYS`. It is required for
   `lab` (`:52`) and `practitioner_clinic` (`:54`). Requirements are a code constant `REQUIRED_BY_TYPE` (`:51-57`);
   moving them to data is out of scope here.
2. **How it is decided now.** `dpa` is not in `DERIVED_STEPS` (`:39`), so it falls through to the stored-row branch
   (`:237-259`): a `partner_onboarding_steps` row or `todo`. The header (`:9-14`) says "DPA … lands with its own VTID".
3. **No writer anywhere.** The `partner_onboarding_steps` CHECK allows `'dpa'`
   (`supabase/migrations/20260924150000_vtid_04478_partner_onboarding_engine.sql:17-19`, comment `:7`), but no route or
   service writes it. `routes/partner-onboarding.ts:10-14` lists DPA among the endpoints still to come. VTID-04938
   `readiness.md:24` and VTID-04941 `plan-sparring.md:13` confirm there is no writer. The spec names
   `POST /:orgId/dpa/sign` (`docs/COMMERCE-SELF-SERVICE-PARTNER-ONBOARDING-SPEC.md:189`; requirement table `:163`, `:221`).
4. **Effect.** `buildChecklist` sets `complete` only when every required step is done
   (`partner-onboarding-checklist.ts:270-281`). `evaluateVerification` (`:292-303`) can therefore never return `live`
   for lab/practitioner_clinic. `dpa` is not a submit prerequisite (`:69`), so submit works but always ends in
   `needs_action`.
5. **MCP next_action.** `services/commerce-mcp.ts:316` puts `dpa` in `ON_SCREEN_STEPS`. `:339` tells the assistant to say
   "Sign the data processing agreement on Vitanaland." and `nextAction()` (`:347-367`) returns the portal link. Today that
   instruction cannot be followed. The ORB label is `orb/profile/commerce-knowledge.ts:25`.
6. **Pattern to copy: partner terms.**
   - Versions table `partner_terms_versions`
     (`supabase/migrations/20261005130000_vtid_04895_partner_terms_lifecycle.sql:32-55`) with one published row
     (`:59-60`) and an immutability trigger (`:62-107`). Browser roles have no write grants (`:116`).
   - Acceptances table: append-only, with a trigger that checks the version is current and the hash matches
     (`:121-195`). Publishing is one RPC `publish_partner_terms_version` (`:200-254`), which computes the hash in the
     database. The delegated-session check is `auth_session_is_delegated` (`:261-278`).
   - VTID-04909 (`…20261006120000_vtid_04909_partner_terms_german_binding.sql:1-26`) made German binding and the only
     hash input, with English required. It was applied via `RUN-MIGRATION.yml` under VTID-04911
     (`docs/validation/VTID-04911/outputs/migration.md:1-10`).
   - Service `services/partner-terms.ts`: binding locale / 11 locales (`:36-43`), fail-closed loader (`:89-106`), display
     shaping (`:136-157`), delegation verdict (`:166-182`).
   - Supplier routes `routes/partner-onboarding.ts`: `GET /:orgId/terms` (`:284-309`) and `POST /:orgId/terms/accept`
     (`:311-391`). Accept refuses delegated sessions (`:319-329`), refuses a version or hash mismatch (`:332-338`),
     checks `shown_locale` (`:341-346`), inserts actor + IP + user agent (`:351-361`), treats 23505 as idempotent
     (`:362`), and emits OASIS `partner_org.terms_accepted` with IP/UA kept out of the payload (`:373-388`).
   - The checklist feeds terms data in at `:151-191`. The terms branch is `partner-onboarding-checklist.ts:221-233`.
   - Admin publishing API `routes/admin-partner-terms.ts:1-20`: exafy_admin only, API only (owner O-2), "No terms text
     lives in code — the owner/legal supplies it through this API". Content validation is `:45-72`. Publish is at about
     `:154`, with event `partner_terms.version_published` at about `:176`. The route is mounted at about `index.ts:1193`; the
     supplier router at about `:1203` (round-1 F2). The own-session guard is `middleware/require-own-session.ts:14-20`.
   - Throwaway-Postgres CI: `.github/workflows/SQL-PARTNER-TERMS.yml:10-48` runs on `*partner_terms*.sql` and
     `scripts/ci/sql-tests/*partner-terms*`, and asserts each `PASS` line.
7. **Evidence / requirements storage today:** `partner_onboarding_steps` (status + `detail` jsonb) and
   `partner_terms_acceptances`. There is no requirement/evidence registry table (grep of migrations for
   `requirement_key`/`supplier_requirement` finds none; the design is only in
   `docs/COMMERCE-SUPPLIER-INFRASTRUCTURE-ARCHITECTURE.md:197`).
8. **Erasure:** `partner_terms_acceptances.accepted_by` is not handled by `erase_user_data` (no migration references it),
   and the append-only trigger would refuse a delete. The DPA record inherits the same question (Open question 7).
Frontend (vitana-v1):
9. `src/components/commerce/SetupHub.tsx`: the "Get ready to sell" hub, rendered from `src/pages/CommercePortal.tsx:595`
   and shown to org admins only (`:14-15`). It loads `GET /partner-onboarding/:orgId`, whose response includes
   `checklist` (`:138-147`), but does not use the checklist yet. The terms row only renders when terms are published
   (`:266-267`). `TermsRow` is at `:291`. The sheet is at `:272`.
10. `src/lib/commerce-terms.ts`: fetch/parse/accept (`:72-126`), the 11 `TERMS_LOCALES` and endonyms (`:23-43`), and a
    plain-text block renderer `termsBlocks` (`:139`, never HTML). `src/components/commerce/PartnerTermsSheet.tsx:1-16`
    holds the UX rules: unticked box, language switch keeps the tick, binding-German notice, RTL, 409 reload.
11. Copy lives in `src/i18n/<locale>/screens.json` under `screens.commerceportal` (de: `:10425`, terms keys around
    `:10957`). 10 shards are on disk (`zh` exists as a directory).
Program: `health-hub-plan-v2.md:50` (D9), `:170` (0L: "partner health AVV + `/dpa/sign` (D9)", owner = counsel), `:175`
(phase 5 depends on 0L AVV).

## Changes (numbered)
1. **Migration `<ts>_vtid_<D9>_partner_dpa.sql`.** A sibling of the terms tables; the terms tables are not touched.
   - `partner_dpa_versions`: same columns, CHECKs, one-published unique index and immutability trigger as
     `partner_terms_versions` after 04909: `binding_locale` default and CHECK `'de'`, `content.de` and `content.en` title
     + body required at publish.
     - Plus an optional per-locale `content.<l>.signing_declaration` text (the declaration the signer ticks). It is
       authored by legal, never an i18n string.
     - No other legal fields. The schema carries text only.
     - RLS SELECT for `authenticated` on published/superseded only. Revoke INSERT/UPDATE/DELETE/TRUNCATE from
       anon/authenticated.
   - `publish_partner_dpa_version(p_id, p_actor)`, `SECURITY DEFINER`, service_role only. It is the terms RPC with a
     German hash: `sha256(de.title || '\n' || de.body_md || '\n' || coalesce(de.signing_declaration,''))`. The
     declaration is part of what is signed, so it is in the hash. It keeps baseline/re-sign semantics
     (`requires_resign` replaces `requires_reacceptance`).
   - `partner_dpa_signatures`, append-only (same trigger shape, cascade-on-org-delete exception):
     - `id`, `partner_organization_id` (FK cascade), `dpa_version_id` (FK), `dpa_version` (filled by trigger),
       `content_sha256`, `shown_locale` (CHECK in the 11 codes).
     - `signed_by uuid NOT NULL`, `signer_email text NOT NULL` (round-1 F3; from the JWT identity), `signer_name text NOT NULL`, `signer_role text NOT NULL`
       (supplier-stated, a declaration and not verified), `declaration_confirmed boolean NOT NULL CHECK (= true)`.
     - `org_snapshot jsonb NOT NULL`: `legal_name`, `country`, `vat_id`, `website` at signing time, so the record names
       the contracting party as it was.
     - `signed_at timestamptz default now()`, `ip_address`, `user_agent`.
     - UNIQUE (`partner_organization_id`, `dpa_version_id`).
     - A BEFORE INSERT trigger refuses an unknown or non-current version and a hash mismatch (`PARTNER_DPA_*` codes).
   - Policies: RLS SELECT via `is_partner_org_member(partner_organization_id)`, as at 04478:46-54. No browser writes.
   - Header comment: "NOT APPLIED BY MERGING"; applied only via `RUN-MIGRATION.yml` after the owner's production approval.
   - Fully idempotent (`IF NOT EXISTS`, `CREATE OR REPLACE`). Nothing existing is altered or dropped. The `'dpa'` value in
     the `partner_onboarding_steps` CHECK stays.
2. **Service `services/partner-dpa.ts`.** It reuses `resolveTermsLocale`, `SUPPORTED_TERMS_LOCALES`, `BINDING_LOCALE` and
   `requestDelegation` from `partner-terms.ts` (exported already; nothing changes there). It provides:
   - `loadCurrentDpa(s)`: fail-closed, like `loadCurrentTerms`. A missing table (migration not yet applied) or a read
     error means "not published".
   - `loadDpaBaselineVersions(s, cur)`.
   - `dpaForDisplay(cur, locale)`: same shape as `termsForDisplay` plus `signing_declaration` for the shown and binding
     locales.
   - `parseSignBody(body)`: `dpa_version`, `content_sha256`, `shown_locale`, `signer_name` (1–200 chars, trimmed),
     `signer_role` (1–120), `declaration_confirmed === true`.
3. **Supplier routes in `routes/partner-onboarding.ts`.** Both are `requireAuth, requireOrgAdmin()`. The header comment
   is updated.
   - `GET /:orgId/dpa?locale=`
     - Returns `{ ok, required, published, dpa, signed, signed_at, signed_version, resign_required }`.
     - `required` comes from `requiredSteps(org.partner_type).includes('dpa')`.
     - When nothing is published it returns `published:false, dpa:null`, never an error.
   - `POST /:orgId/dpa/sign`, checks in order:
     1. Delegated or unknown session → 403 `DPA_SIGNATURE_REQUIRES_SUPPLIER`, same message pattern as `:325-327`.
     2. Nothing published → 503 `DPA_NOT_PUBLISHED`.
     3. Version or hash mismatch → 409 `DPA_VERSION_MISMATCH` / `DPA_CONTENT_MISMATCH`.
     4. `shown_locale` not carried by the version → 400.
     5. Body invalid → 400 `INVALID_SIGNATURE`.
     6. Org not found → 404.
     7. Partner type does not require a DPA → 409 `DPA_NOT_REQUIRED`.
     8. Company facts incomplete (`legal_name`/`country`) → 409 `DPA_COMPANY_INCOMPLETE`, because the record must name
        the party.
     9. Otherwise insert the signature: `signed_by` from the JWT, `signer_email` from the identity, the org snapshot,
        IP, and the user agent cut to 500 characters.
   - 23505 means `already_signed: true` (idempotent). A trigger race returns 409 `DPA_CONTENT_MISMATCH`.
   - On a new row only, emit OASIS `partner_org.dpa_signed`:
     - `vtid` = this VTID, `source: 'partner-onboarding'`, `status: 'success'`.
     - Payload: org id, version, version id, hash, shown_locale, `actor_id`.
     - IP, user agent, signer name and signer role stay in the row only.
   - Respond with `respondWithState` so the client gets the new checklist.
4. **Checklist derives `dpa`** (`partner-onboarding-checklist.ts`).
   - Add `'dpa'` to `DERIVED_STEPS` and a `case 'dpa'` that mirrors `terms` (`:221-233`):
     - No published version → `todo`, `missing: ['dpa_not_published']` ("pending legal text").
     - A signature on any baseline version → `done`.
     - Otherwise `todo`, `detail: { current_version }`.
   - `ChecklistInput` gains `signedDpaVersions`, `currentDpaVersion`, `dpaBaselineVersions?`.
   - `loadChecklist` (`routes/partner-onboarding.ts:151-191`) reads `partner_dpa_signatures` and the current DPA version
     in their OWN try/catch calls, run before the existing `Promise.all` exactly like `loadCurrentTerms`/
     `loadBaselineVersions` (`:156-157`), never inside it (round-1 F6). An error, or a missing table before the migration,
     gives an empty list / null rather than a 500 and cannot fail the rest of the checklist; the step shows open.
   - A stored `dpa` row in `partner_onboarding_steps` is ignored from now on, as the derived steps already are. Nothing
     is deleted.
5. **Admin publishing API `routes/admin-partner-dpa.ts`**, mounted at `/api/v1/admin/partner-dpa` next to
   about `index.ts:1193`.
   - Same shape as `admin-partner-terms.ts`: `requireAuth, requireExafyAdmin`, `requireOwnSession` on writes.
     `GET /`, `POST /` (draft), `PUT /:id` (draft only), `POST /:id/publish` (RPC).
   - Content validation reuses `parseTermsContent`, extended by an optional `signing_declaration` per locale. Extract a
     shared validator only if it stays a pure move.
   - OASIS events: `partner_dpa.draft_saved`, `partner_dpa.version_published`, `partner_dpa.resign_required`.
   - API only, no admin screen (same as owner decision O-2 for terms). **No DPA text is committed to the repo.** The
     owner/legal supplies it through this API after counsel sign-off.
6. **MCP next_action** (`services/commerce-mcp.ts:347-367`).
   - When the open step is `dpa` and `missing` includes `dpa_not_published`, return `supplier_action: 'Vitanaland is still
     preparing the data processing agreement; nothing to do yet.'` with `link: null`.
   - Otherwise keep `:339` and the link. Apply the same rule to `terms_not_published`, which has the same flaw today. This is a sibling fix in the same function and is named as such in the PR description (round-1 F4).
   - This text is prompt/tool text in English per §13b and is not spoken by Vitana.
7. **Frontend `src/lib/commerce-dpa.ts`.** Fetch/parse/sign mirroring `commerce-terms.ts:72-126`. It reuses
   `TERMS_LOCALES`, `TERMS_LANGUAGE_NAMES` and `termsBlocks`, and exports `signBody()` and `isStaleDpaError()`.
8. **Frontend `PartnerDpaSheet.tsx`.** Same UX rules as `PartnerTermsSheet.tsx:1-16`:
   - One language at a time with a switch, the binding-German notice, RTL for `ar`, plain-text blocks only.
   - Two inputs: full name and role/position.
   - A checkbox whose label is the version's `signing_declaration` (legal text from data). When a version has none, a
     catalogue fallback "Ich habe den Vertrag gelesen und unterschreibe ihn für {legal_name}" is used; legal confirms the
     wording, see Open question 4.
   - Sign stays disabled until the name, the role and the tick are all there.
   - On a 409 the new text loads and the tick is cleared.
9. **`SetupHub.tsx`.** It uses `ob.checklist` (already fetched at `:138-147`) to find the `dpa` step. When the step is
   `required`, a `DpaRow` renders below the terms row (pattern `:291`):
   - signed → "Version {v} unterschrieben am {date}" (`fmtDate`);
   - pending → open the sheet;
   - re-sign needed → reworded row;
   - `dpa_not_published` → a non-clickable row "Auftragsverarbeitungsvertrag — wird gerade von Vitanaland vorbereitet",
     state `todo`, `data-testid="setup-dpa"` and `data-state`.
   Nothing renders for partner types that do not require a DPA.
10. **i18n.** New keys go in `screens.commerceportal.dpa.*`: row titles and bodies, pending-legal-text, sheet title,
    name/role labels, fallback declaration, sign button, signed toast, stale-text notice, binding-language notice and
    error toasts.
    - Written in German first (du-form), then English, then the other locales via `scripts/translate-keys.mjs`, marked
      `_pending_review`.
    - Then run `npm run i18n:inventory`.
    - The legal text itself is shown in the language the version carries, with the binding-German note. It is never
      machine-translated by the app.
11. **CI SQL test.** Add `scripts/ci/sql-tests/run-partner-dpa-test.sql` (or extend the runner). Widen
    `SQL-PARTNER-TERMS.yml` paths to `*partner_dpa*` and assert `PASS <vtid> partner dpa lifecycle`.
12. **Docs.** `DATABASE_SCHEMA.md` rows for the two tables and the RPC, marked "pending apply" until applied.
    `docs/validation/<VTID>/` gets `plan-sparring.md`, `staging-tests.json` and `acceptance.md`. No What's New entry:
    the feature is partial until legal publishes. No screen-registry change: the sheet adds no route.

## Rollout
1. Spar → Gate 1 → allocate VTID (cite the sparring record) → implement both repos → local checks → PRs → merge.
   - Platform first: the code is safe without the migration because every read is fail-closed and shows "not
     published".
   - Then v1.
2. Staging deploy + STAGING-VERIFY (read-only, below) → Gate 2 → production deploy pinned to the verified commits. At
   that point every lab/clinic shows "pending legal text", which is the honest state.
3. **Migration**: only after the owner's production approval, via `RUN-MIGRATION.yml` (pattern:
   `docs/validation/VTID-04911/outputs/migration.md`), followed by a read-only check that both tables exist and are
   empty. Record the result in `outputs/migration.md`.
4. **Legal text (owner/counsel, outside engineering).** An exafy_admin creates a draft through
   `/api/v1/admin/partner-dpa` with the counsel-approved DE + EN text (and optional translations), then publishes it.
   That is a production write by the owner, a separate approval, and never done by a session.
   - Until this happens, no lab/clinic can reach `live` through the engine. That is correct and stays visible as
     `dpa_not_published`.
5. Rollback: revert the gateway routes. The tables stay; they are inert without routes. No data migration exists to
   undo.

## Staging verification (read-only)
`docs/validation/<VTID>/staging-tests.json`:
- `GET /api/v1/partner-onboarding/00000000-0000-0000-0000-000000000000/dpa?locale=de` → 401 JSON (mounted, needs session).
- No probe of `POST …/dpa/sign`: every non-GET is left to Jest, so the staging suite stays GET-only.
- `GET /api/v1/admin/partner-dpa` → 401 JSON.
- Existing-suite ref: the Jest files below, plus the SQL CI job.
- Optional signed-in read-only Playwright on staging as the test user: the Commerce Portal renders, and if the test user
  administers a lab/clinic org, `setup-dpa` shows `data-state="todo"` with the pending text. No click on Sign. The
  network guard aborts non-GET requests.
Nothing is published, signed or created on staging, because staging shares the production database.

## Tests
- **Jest (gateway, in-memory Supabase mock, the pattern used by `test/partner-onboarding.test.ts`).** New
  `test/vtid-<D9>-partner-dpa.test.ts` covers:
  - GET with nothing published → `published:false`, and with a version published.
  - Locale fallback to German; `ar` → rtl.
  - Sign happy path: the inserted row has signer, org snapshot, hash, IP and user agent; the OASIS event has no
    IP/UA/name.
  - Refusals:
    - delegated → 403 (both checks);
    - unknown session → 403;
    - version or hash mismatch → 409;
    - bad `shown_locale` → 400;
    - missing name/role/declaration → 400;
    - non-required partner type → 409;
    - incomplete company → 409.
  - Idempotent second sign (23505); trigger race → 409.
  - Read errors fail closed.
- **Checklist tests** (extend `vtid-04478-partner-onboarding-checklist.test.ts` and
  `vtid-04953-checklist-policy.test.ts`):
  - lab without a DPA version → `dpa` todo with `dpa_not_published`, `complete:false`;
  - signed → done, and `evaluateVerification` returns `live` when everything else is done;
  - a baseline re-sign reopens the step;
  - a stored `dpa` row no longer overrides;
  - service_provider → `not_required`.
- **MCP:** extend `vtid-04941-commerce-mcp-automation.test.ts`: `dpa` with `dpa_not_published` → waiting action with no
  link, otherwise the sign action with the link (same for terms).
- **Admin API:** `test/admin-partner-dpa.test.ts`, mirroring `admin-partner-terms.test.ts`: exafy_admin only, own
  session, DE+EN required, draft-only edits, publish emits events.
- **SQL (throwaway Postgres CI):**
  - published immutability;
  - one published version;
  - hash computed by the database, including the declaration;
  - signature trigger refuses stale or wrong hash;
  - append-only, with cascade on org delete allowed;
  - CHECK `declaration_confirmed = true`;
  - browser roles have no write grant;
  - RLS limited to org members;
  - migration idempotent on re-run.
- **Vitest (v1):**
  - `commerce-dpa` parse/signBody;
  - `PartnerDpaSheet`: the Sign button stays disabled until name, role and tick are present; a language switch keeps the
    tick; a 409 clears it; RTL;
  - `SetupHub`: the DPA row appears only when the checklist requires it, shows pending-legal-text when not published,
    and shows the signed state.
- Lint (i18n rules), typecheck, build, `npm test` in both repos.

## Not in scope
- The DPA/AVV text itself and any legal judgement (owner/counsel).
- An advanced or qualified e-signature provider. If counsel requires one, this plan stops and is re-sparred.
- Vitanaland counter-signature workflow, PDF generation or emailing a signed copy, termination/withdrawal of a DPA.
- Moving `REQUIRED_BY_TYPE` to a requirements data table (§13c rule 2 debt, already present; flagged, not repaid here).
- Licence/accreditation evidence (spec Q6), `results_channel`, `billing_mandate`, `tracking_test`.
- An admin screen for publishing (API only, as for terms).
- Health data processing for partners (phase 5), which this unblocks only.
- Erasure handling of signer identity (Open question 7).

<!-- plan:end -->
