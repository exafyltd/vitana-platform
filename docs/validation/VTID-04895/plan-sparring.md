# VTID-04895 — Plan sparring record

- Final plan hash (sha256 of the text between the plan markers): `b646c8042119bc67f63fe9dc33c4abdad3c501b9c6b73fd3db74619aa674c6b6`
- Partner: independent `plan-sparring-partner` agent (read-only), 2 rounds
- Verdict: **converged**
- Owner decisions and approval: in chat, 2026-10-05 (O-1 live stays live, banner/status only; O-2 API only; O-3 English binding, German as displayed translation; "Approved, proceed with the partner terms implementation now"). Recorded in `vtid_ledger.metadata.plan_sparring` (session fallback).

## Round 1 findings (partner, in substance)

- F1 major — the `client_id` claim on Supabase OAuth tokens was unproven; the refusal gate depended on it.
- F2 major — the baseline re-acceptance rule needed a history scan; proposed copying acceptances forward instead.
- F3 major — the immutability trigger as described would block superseding (published → superseded).
- F4–F8 minor — unique/consistency of the new columns, 409 handling in the sheet, MCP deep link, migration ordering, unverified empty table.

## Round 2 findings (partner)

- F9 minor — draft → published wording in the trigger. F10 minor — new dependency on `auth.sessions.oauth_client_id`.

---

# Plan — Partner terms lifecycle: publish, show, accept, re-accept

Change class: **standard** (migration, admin routes, an auth rule on the accept route, frontend supplier sheet). Repos: vitana-platform (gateway + migration), vitana-v1 (supplier terms sheet).

<!-- plan:begin -->
## Owner request (2026-10-05, fixed)

`terms_not_published` blocks every supplier from submitting. Build the partner-terms lifecycle only.
1. Vitanaland can publish one active partner-terms version.
2. The supplier sees the current terms inside Vitanaland.
3. The supplier must accept them explicitly.
4. Store the business ID, the terms version, the accepting user's ID and the timestamp.
5. AI agents may explain the terms and guide the supplier to them, but may never accept on the supplier's behalf.
6. When a new version is published, suppliers that need to re-accept become pending until they accept the new version.
7. Acceptance is auditable.

Out of scope: catalogue, verification, billing and any MCP change.

## Audit (verified against the code)

- **Tables.** `partner_terms_acceptances` (migration `20260924150000_vtid_04478_partner_onboarding_engine.sql:30-59`):
  - Columns: `partner_organization_id`, `terms_version TEXT`, `accepted_by UUID`, `accepted_at`, `ip_address`, `user_agent`. UNIQUE (org, version). RLS: org members can read; anon/authenticated cannot write.
  - **There is no terms-text or terms-version table.** The terms text is not stored anywhere.
- **Versioning.** The version in force is the env var `PARTNER_TERMS_VERSION` (`routes/partner-onboarding.ts:94-98`, `currentTermsVersion()`). Neither `AWS-STAGE-DEPLOY-GATEWAY.yml` nor `AWS-PROD-DEPLOY-GATEWAY.yml` sets it, so the value is null on staging and production. That null is `terms_not_published`.
- **Admin publishing.** None. The only path is redeploying with an env var. No admin route, no Command Hub or admin UI.
- **Acceptance storage.** It exists. `POST /api/v1/partner-onboarding/:orgId/terms/accept` (`routes/partner-onboarding.ts:427-467`):
  - Requires an org admin.
  - Requires the body's `terms_version` to equal the current version; otherwise 409 `TERMS_VERSION_MISMATCH`, or 503 when nothing is published.
  - Inserts an acceptance (idempotent on 23505) and emits `partner_org.terms_accepted`.
- **How onboarding checks terms.** `buildChecklist` (`services/partner-onboarding-checklist.ts:172-181`):
  - With no current version: `todo` + `missing: ['terms_not_published']`.
  - When the org accepted exactly the current version: `done`.
  - Otherwise: `todo` with `current_version`.
  - `terms` is required for every partner type (`:47-51`) and is a submit prerequisite (`SUBMIT_PREREQUISITES`, `:64`).
- **Is acceptance tied to a version?** Yes, by string. It is not tied to the content: nothing records what text the version contained, so an acceptance cannot prove what was shown.
- **Re-acceptance.** It is implicit and all-or-nothing. A new env version makes every earlier acceptance stale in the checklist, but:
  - there is no "editorial vs material change" distinction;
  - a **live** org's lifecycle is never touched, because the checklist only gates submit and verification;
  - nothing tells anyone that re-acceptance is due.
- **AI agents.** The MCP has no accept tool. Its instructions say terms are accepted on Vitanaland (`services/commerce-mcp.ts:24-25,59`), and a test pins "accepting terms is not one".
  - **Gap:** the REST accept route takes any valid user JWT, including an OAuth-delegated token an assistant received through the MCP connection. Those tokens carry a `client_id` claim (read at `routes/commerce-mcp.ts:131`; `requireAuth` exposes raw claims as `req.auth_raw_claims`). So an agent holding the supplier's token could call the accept route directly.
- **Frontend.** No terms UI exists in vitana-v1. Nothing calls `/terms/accept`, and SetupHub's steps (`components/commerce/SetupHub.tsx:48-70`) do not include terms.
- **OASIS.** Only `partner_org.terms_accepted` (`types/cicd.ts`, VTID-04478). There is no publish event and no re-acceptance event.

## Design

### A. Data (one migration, platform repo)
- **New `partner_terms_versions`:**
  - `id uuid pk`, `version text unique not null` (e.g. `2026-10`), `status text check in ('draft','published','superseded')`.
  - `requires_reacceptance boolean not null default true`.
  - `content jsonb not null` (`{ <locale>: { title, body_md } }`), `binding_locale text not null`, `content_sha256 text`.
  - `created_by`, `created_at`, `published_by`, `published_at`.
  - A partial unique index allows exactly one `published` row.
  - Immutability trigger (BEFORE UPDATE/DELETE, fires for the service role too). It allows exactly:
    - any change while the row stays a draft (`OLD.status = 'draft' AND NEW.status = 'draft'`). Content is finalized before publishing;
    - `draft → published`, setting only `status`, `published_by`, `published_at`, `content_sha256` and `baseline_version_id`;
    - `published → superseded`, changing only `status`.
    - Everything else on a published or superseded row raises, including any change to `content`, `version`, `binding_locale`, `content_sha256`, `requires_reacceptance` or `baseline_version_id`. DELETE of a non-draft row raises.
  - `baseline_version_id uuid`, set at publish: the version's own id when `requires_reacceptance`, otherwise the previous published version's `baseline_version_id`. The first publish is always its own baseline: `requires_reacceptance` is forced true when no version has been published before.
  - RLS: authenticated users can read published and superseded rows; anon/authenticated cannot write.
- **`partner_terms_acceptances` gains:**
  - `terms_version_id uuid` (FK to `partner_terms_versions`), `content_sha256 text` (what was shown), `shown_locale text`.
  - A trigger refuses UPDATE/DELETE, making it append-only.
  - Columns are `terms_version_id` (with a `CHECK (terms_version_id IS NOT NULL) NOT VALID` so every new row needs it), `content_sha256` and `shown_locale`. A trigger fills `terms_version` from the FK on insert, so the two can never disagree.
  - New `UNIQUE (partner_organization_id, terms_version_id)`; the existing `(org, terms_version)` unique stays.
  - Verified read-only on 2026-10-05: production has **0** rows in `partner_terms_acceptances`.
  - The existing columns cover the owner's required fields: org = business ID, `terms_version`, `accepted_by`, `accepted_at`.
  - Existing rows: none in production (the accept route has always answered 503), so the new columns are nullable for history only.
- Update `DATABASE_SCHEMA.md`.

### B. Version in force (gateway)
- `currentTerms()` reads the single `published` row (version, id, requires_reacceptance, content hash). It replaces the `PARTNER_TERMS_VERSION` env read, which is never set anywhere. No row means `terms_not_published`, exactly as today.
- **Re-acceptance via the stored baseline (simplified).** Each published version carries `baseline_version_id` (section A).
  - An org has accepted the terms in force if it has an acceptance of any version whose `baseline_version_id` equals the current version's `baseline_version_id`. That is one query: acceptances join versions on the baseline.
  - An editorial update (`requires_reacceptance = false`) keeps the baseline, so existing acceptances stay valid. A material update starts a new baseline.
  - Nothing is ever copied forward. Every acceptance row is an act of the user named in it. (We do not copy forward because copying would fabricate acceptances.)
- `loadChecklist` passes `termsAccepted: boolean | null` (null = nothing published) and `currentVersion` to `buildChecklist`. The `terms` step logic keeps its outputs: `terms_not_published`, `done`, or `todo` with `detail.current_version`. `SUBMIT_PREREQUISITES` is unchanged.
- **`currentTerms()` fails closed.** If the table is missing (42P01, migration not applied yet) or the query errors, it logs and returns null, which means today's `terms_not_published`. The gateway therefore never depends on the migration landing first.

### C. Admin publishing (gateway, exafy_admin only)
- `GET /api/v1/admin/partner-terms` lists versions.
- `POST /api/v1/admin/partner-terms` creates a draft from `{ version, binding_locale, content, requires_reacceptance }`.
- `PUT /api/v1/admin/partner-terms/:id` edits a draft only.
- `POST /api/v1/admin/partner-terms/:id/publish`. In one RPC transaction it computes `content_sha256`, supersedes the current published row and publishes this one. It emits `partner_terms.version_published`, and, when `requires_reacceptance`, `partner_terms.reacceptance_required` with the count of affected orgs.
- All routes use `requireExafyAdmin`.
- **Owner decision O-3:** English is the binding language. A version must contain `content.en`, and `binding_locale` is fixed to `en`. German (or another locale) may be stored and shown alongside as a translation, but the accepted legal version is the English text. `content_sha256` is the hash of the English (binding) title + body. The supplier sheet always shows the English binding text and may show the translation next to it, labelled as a translation.
- **The terms text comes from the owner/legal.** Nothing is published by this change. No legal text is written in code (Commerce rule 13c-7).

### D. Supplier view and acceptance (gateway + vitana-v1)
- `GET /api/v1/partner-onboarding/:orgId/terms` (org admin) returns the current version's title/body in the caller's locale, falling back to the binding locale with a `fallback: true` flag. It also returns the version, the content hash and whether this org has accepted under the baseline rule.
- `POST /:orgId/terms/accept` gains:
  - **Delegated-token refusal, two independent checks, fail closed.** It refuses with 403 `TERMS_ACCEPTANCE_REQUIRES_SUPPLIER` when either check fails:
    1. The verified token carries a `client_id` claim. Supabase documents that every access token its OAuth 2.1 server issues includes `client_id`, and its own RLS pattern for "direct user" is `client_id IS NULL`.
    2. A SECURITY DEFINER RPC `auth_session_is_delegated(session_id)` (service role only) reports that the token's `session_id` belongs to an `auth.sessions` row with a non-null `oauth_client_id`. The column exists, verified read-only 2026-10-05. A missing `session_id`, a missing session or an RPC error also refuses.
    - Acceptance is therefore only ever the supplier's own signed-in session, on Vitanaland.
    - The RPC is the gateway's first dependency on Supabase Auth's internal `auth.sessions.oauth_client_id`. The migration comments it: re-verify after any Supabase Auth upgrade. If the column changes, the RPC errors and acceptance is refused (fail closed, never open).
  - `content_sha256` in the body must match the published row, so the accepted text is exactly the text shown; otherwise 409 `TERMS_CONTENT_MISMATCH`.
  - It stores `terms_version_id`, `content_sha256` and `shown_locale`. Together with the existing columns, every acceptance records the org/business, the user, the exact terms version, the content hash, the language shown and the accepted timestamp, as the owner requires. The OASIS `partner_org.terms_accepted` payload adds `terms_version_id` and `content_sha256`.
- **vitana-v1, a "Partner terms" sheet** (a `ResponsiveDialog`, not a new route) opened from the Commerce SetupHub:
  - The terms step shows its state: todo / accepted / re-acceptance needed.
  - The sheet renders the current text (markdown, plain rendering), the version and the date.
  - An unchecked checkbox "I have read and accept the partner terms (version X)". Accept stays disabled until it is checked.
  - The MCP status already carries `portal_link` = `/commerce?org=…`. The Commerce page opens the terms sheet when that org's terms step is open, so the assistant's existing guidance ("give them the link from the status") lands on the terms. No MCP change: `shapeStatus` passes steps through generically.
  - On 409 `TERMS_CONTENT_MISMATCH` or `TERMS_VERSION_MISMATCH` (a new version was published while the sheet was open), the sheet re-fetches the terms, unticks the checkbox and shows "The terms were updated — please read the current version."
  - The sheet always shows the English binding text, and, when the user's locale has a translation, shows it alongside, labelled "Translation — the English version is binding". `shown_locale` records which languages were displayed: `en` or `en+de`.
  - i18n for all 11 locales; RTL-safe.

### E. Re-acceptance: "pending" for live suppliers
- On a material publish, an org that had accepted under the previous baseline gets `terms_status = 'reacceptance_required'`. This is derived, not stored: the status response and SetupHub show a banner until it accepts.
- **Owner decision O-1 (2026-10-05):** live suppliers remain live. Re-acceptance is a banner and status requirement only. There is no automatic pause or suspension, and no lifecycle change.
- Orgs in draft/submitted/verifying follow the checklist (the terms step reopens). An org in verification goes to `needs_action` through the existing `evaluateVerification`.

### F. Audit
OASIS events:
- `partner_terms.version_published` (version, id, hash, requires_reacceptance, actor);
- `partner_terms.reacceptance_required` (version, affected org count);
- `partner_org.terms_accepted` (+ version id, content hash, shown locale; IP/UA stay in the table only, not in OASIS).
All three are registered in `CicdEventType`. Append-only acceptances and immutable published versions make the record tamper-evident.

### G. Tests
- **Gateway Jest:**
  - the baseline rule (first version, editorial update keeps acceptance, material update reopens);
  - publish (exactly one published, older superseded, hash computed, events);
  - draft-only edits;
  - admin gate;
  - accept refuses a delegated token (`client_id` claim);
  - accept refuses a content-hash mismatch and stores id/hash/locale;
  - no terms → `terms_not_published` unchanged;
  - the support/operator regression suites stay green.
- **Migration test** (static): one-published index, immutability trigger, append-only trigger.
- **vitana-v1 Vitest:** the sheet renders text and version, Accept is disabled until the box is checked, it posts version + hash, the re-acceptance banner shows, keys exist in 11 locales.
- **Staging specs** (read-only; staging uses the production Supabase): `GET /terms` for an unsigned caller → 401; the admin publish route unsigned → 401. Acceptance and publishing are proven by Jest; nothing is published during verification.

### Scope
- **vitana-platform:**
  - one migration;
  - `routes/partner-onboarding.ts` (terms routes, `currentTerms`, `loadChecklist`), `services/partner-onboarding-checklist.ts` (terms derivation), a new `routes/admin-partner-terms.ts` + mount, `types/cicd.ts`;
  - tests, `DATABASE_SCHEMA.md`, `docs/validation/<VTID>/*`.
  - Remove the `PARTNER_TERMS_VERSION` reads, plus its line in `.claude/rules/infrastructure.md` and `domain-atlas.ts`.
- **vitana-v1:** a `PartnerTermsSheet` component, SetupHub terms step/banner, i18n ×11, tests, a staging spec, `docs/validation/<VTID>/*`.
- **Not touched:** MCP tools/instructions (the existing "accepted on Vitanaland, give them the link" guidance stays), catalogue, verification, billing.

### Rollout
Platform PR first (it is backward compatible: no published row means behaviour is unchanged), then the frontend PR. Once both are on staging, the owner supplies the terms text and publishes version 1 through the admin API. **Owner decision O-2:** API only in this task. No Command Hub or admin publishing UI.
<!-- plan:end -->

## Owner decisions (2026-10-05)
O-1 flag only, no pause; O-2 API only; O-3 English binding, German as a displayed translation.

## Planner responses — round 1

- F1 [major] ACCEPTED, with evidence and an extra check:
  - Supabase's OAuth 2.1 docs (searched 2026-10-05) state that every OAuth access token includes `client_id`, and give `(auth.jwt() ->> 'client_id') IS NOT NULL` as the test for an OAuth client.
  - Added an independent second check: the session lookup against `auth.sessions.oauth_client_id` (the column is verified present). Both checks fail closed.
  - Tests cover each check alone.
- F2 [major] ACCEPTED in part.
  - The derivation is simplified to a stored `baseline_version_id` (one join, no history scan).
  - REJECTED the copy-forward of acceptances: it would create acceptance rows that no user made, which breaks requirement 7 (auditable) and the owner's "accepted by user ID".
  - The `requires_reacceptance` flag stays, because the owner's requirement 6 says "suppliers that require re-acceptance", which implies not every new version does.
- F3 [major] ACCEPTED. The trigger's allowed transitions are spelled out.
- F4 [minor] ACCEPTED. NOT VALID check, FK-derived `terms_version`, new unique constraint.
- F5 [minor] ACCEPTED. 409 → re-fetch, untick, notice.
- F6 [minor] ACCEPTED. The existing `portal_link` deep-links to the sheet; no MCP change.
- F7 [minor] ACCEPTED. `currentTerms()` fails closed on a missing table.
- F8 [minor] ACCEPTED. Verified 0 rows (read-only).
- Owner decisions O-1..O-3 (received 2026-10-05) are folded in; they are fixed.

## Round 2 — partner disposition

F1, F3–F8 closed. F2 acknowledged (stored baseline accepted; the no-copy-forward reason accepted). New minors:
- F9: the draft→published trigger wording. ACCEPTED: drafts are edited only while they stay drafts, and publishing changes only the listed columns.
- F10: the dependency on `auth.sessions`. ACCEPTED: the migration comment re-verifies after Supabase upgrades, and the check fails closed. DEFERRED: a scheduled schema-drift health probe, tracked as a follow-up and not in this VTID.

## Verdict

CONVERGED after 2 rounds (standard, cap 3). Final plan hash: b646c8042119bc67f63fe9dc33c4abdad3c501b9c6b73fd3db74619aa674c6b6
