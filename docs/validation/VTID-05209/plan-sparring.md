# VTID-05209 — Plan sparring record

- **Plan:** Commerce profile friction — infer and prefill country and website (follow-up 1 of VTID-05204)
- **Change class:** standard (gateway routes + Commerce MCP status; three supplier screens)
- **Plan hash (sha256, NFC, trailing whitespace stripped, blank runs collapsed, text between the plan markers):**
  `8e9850bb462cb911555690583245ac8f9be20e01fe3c4976a1928ebdd3062746`
- **Partner:** `plan-sparring-partner` (independent, read-only), 2 rounds
- **Verdict:** CONVERGED — round 1: 1 major + 5 minor, all accepted; round 2: all closed, no new findings
- **Owner approval:** 2026-10-15 in session: Approved.
- **Owner constraints with the approval:** no silent persistence of inferred country or website; saved business values
  always take precedence; conflicting reliable sources fall back to asking the supplier; no IP-based inference; no new
  website-fetching path outside the existing AI setup flow; merge gateway first, frontend second; "Your assistant can
  do this" stays out of this VTID.
- **Repos:** `exafyltd/vitana-platform` (gateway) and `exafyltd/vitana-v1` (frontend); one VTID for both.

## Final plan

<!-- plan:begin -->
## Goal (owner, 2026-10-15)
Follow-up 1 of VTID-05204. Reduce Commerce profile friction by inferring/prefilling the business country and
website from data Vitanaland or the connected AI already knows; ask the supplier only when a value cannot be
inferred reliably. Applies the Commerce UX contract (vitana-v1 `CLAUDE.md` → "Commerce UX contract", platform
`.claude/rules/backend.md` Commerce rule 9).

Change class: **standard** (a new gateway route + Commerce MCP status change in vitana-platform, three supplier
screens in vitana-v1). Deploys in both repos → STAGING-VERIFY and Gate 2.

## Where country and website are asked today (verified in code)
1. Registration, step 2 (`src/components/commerce/RegisterOrgDialog.tsx`): name, website (optional, empty),
   country select preselected from the browser language region (`guessCountry`, `src/lib/commerce-countries.ts`).
2. Setup hub → "Business profile" row → `ProfileSheet` (`src/components/commerce/SetupHub.tsx` ~L585–680): website
   + country select; the row is `todo` while `organization.country` is null. Saves via
   `PATCH /api/v1/partner-onboarding/:orgId/company`.
3. AI setup review (`src/components/commerce/AiSetupSheet.tsx` + `src/lib/commerce-ai-setup.ts` `reviewFromDraft`):
   country = what the AI read on the page (`services/commerce-ai-setup.ts` stays null unless the page states it)
   else the browser-region guess. The website is always known here (the supplier typed it).
4. Commerce MCP (`services/gateway/src/services/commerce-mcp.ts`): `update_business` takes country/website; the
   status the AI reads has no suggestion, so the AI has to ask the supplier.

## What Vitanaland already knows (sources), strongest first
- **Already stored** on the org (`partner_organizations.country/website/vat_id`): never ask again.
- **VAT ID prefix** (EU VIES format, `EL`→`GR`): reliable for country.
- **Website country-code domain** (`.de`→DE, `.at`→AT, `.co.uk`/`.uk`→GB, …) from a fixed allowlist of real
  ccTLDs; multi-part public suffixes (`.co.uk`, `.org.uk`, `.com.au`, `.co.nz`, `.com.br`, `.co.at`, …) are
  matched from a short explicit map BEFORE the last label is read, so `shop.example.co.uk` → GB; generic and
  "vanity" domains (`.com .net .org .eu .io .co .ai .me .tv .fm .ly .app .shop …`) give
  nothing. Reliable enough to prefill.
- **Confirmed account email domain**: a business address (`anna@kraeuterhaus.de`) suggests the website
  `https://kraeuterhaus.de`; free-mail domains (the existing `FREE_EMAIL_DOMAINS`,
  `services/partner-verification.ts`) give nothing. Unconfirmed emails give nothing. The same domain match is
  what the verification step already accepts as website-ownership proof, so the suggestion also shortens
  verification.
- **What the AI read on the website** (AI setup draft; MCP: whatever the connected AI supplies): unchanged.
- **Browser language region**: weak. Kept only as today's preselect when nothing reliable exists; never shown as
  "we found this".
Two reliable sources that disagree (VAT `AT…`, website `.de`) → no inference for that field: ask.

## Change 1 — vitana-platform (gateway)
- New pure helper `services/gateway/src/services/commerce-company-inference.ts`:
  `inferCompanyFacts({ stored, vatId, website, email, emailConfirmed })` →
  `{ country: { value, source } | null, website: { value, source } | null }`, `source` ∈
  `stored | vat_id | website_domain | email_domain`. Pure, no I/O; the ccTLD allowlist and the vanity list live
  in that file; `FREE_EMAIL_DOMAINS` is imported, not copied.
- New routes, read-only, plain business facts only (no IDs, no internal step keys — rule 9):
  - `GET /api/v1/partner-onboarding/company-suggestions` (requireAuth; optional `website` query for a website the
    supplier is typing) — for registration, before an org exists. **Registered before `router.get('/:orgId', …)`**
    (`routes/partner-onboarding.ts` ~L247), otherwise `/:orgId` captures it; a route test asserts the order.
  - `GET /api/v1/partner-onboarding/:orgId/company-suggestions` (requireAuth + the existing `requireOrgAdmin()`,
    which reads `req.params.orgId`) — for the profile sheet; adds the org's stored country/website/vat_id.
  - Both read the caller's email and confirmed flag with the existing `readEmailConfirmation()`
    (`services/partner-verification-io.ts`, one `auth.admin.getUserById` call; the JWT carries no confirmed flag).
    `unconfirmed`/`unavailable` → no email-domain suggestion. Response:
    `{ ok, country: {value, source}|null, website: {value, source}|null }`. Writes nothing.
- Commerce MCP status: the `get_onboarding_status` handler (and the other handlers that return `shapeStatus`)
  computes the suggestion before shaping — `readEmailConfirmation(ctx.caller)` + the org facts from the body →
  `inferCompanyFacts` — and passes it to an extended `shapeStatus(body, portalUrl, suggested?)` (optional third
  argument; existing callers and tests unchanged). While country or website is missing the status adds
  `suggested: { country?, website? }` (value + plain-words source) and the company step's `next_action` says to
  confirm the suggestion with the supplier and then call `update_business`, instead of asking an open question.
  Nothing is written by the suggestion itself.
- No migration. No change to `PATCH /company`, `registerPartnerOrg` validation, verification or the checklist.

## Change 2 — vitana-v1 (supplier screens)
- `src/lib/commerce-suggestions.ts`: `fetchCompanySuggestions(orgId?, website?)` via `adminFetch`; any failure
  returns `{ country: null, website: null }` (the screens then behave exactly as today).
- **Registration step 2**: website prefilled from the email-domain suggestion (editable; small hint
  "From your email address"). Country: when a reliable suggestion exists (website domain, typed or prefilled),
  show one line "Country: Germany · Change" instead of the select; "Change" reveals the select. Without a
  reliable suggestion: the select with today's browser preselect (unchanged behaviour).
- **Business profile sheet**: opens with stored or suggested values; when both are known it shows a short
  summary (country, website, where each came from) with one dominant "Save" button and a "Change" link; the
  inputs appear only on "Change" or when a value is missing.
- **AI setup review**: country = AI-read country, else the website-domain suggestion for the website being read,
  else today's browser guess (shown as the editable select, as today).
- Never saved silently: a suggestion is only stored when the supplier taps the screen's one main button
  (country is legally relevant — VAT, terms, jurisdiction).
- i18n: DE first, then 10 locales (du-form), for: "Country: {name}", "Change", "From your email address",
  "From your website address", "From your VAT ID", profile summary title. No raw strings.
- Spotlight/design: tokens only in touched lines; RTL-safe (logical properties).

## UX acceptance (Commerce UX contract)
| | Before | After |
|---|---|---|
| Registration step 2 — fields shown | name, website (empty), country select | name, website (prefilled when a business email exists), country as one confirm line when reliable |
| Required fields typed | name + country choice (+ website optional) | name only when email domain + ccTLD resolve; otherwise as before |
| Decisions | pick country from ~200 | confirm or "Change" |
| Business profile sheet | two empty/partial inputs | summary + one "Save" when both are known; inputs only when missing |
| AI setup review | country often blank/browser guess for a `.de` site | country filled from the site's domain |
| AI/MCP path | AI asks "which country / website?" | AI confirms the suggested values |
- **User steps:** unchanged count (registration 2 steps; profile 1 sheet); fewer inputs per step.
- **Anything asked that Vitanaland or the AI could infer:** none when a reliable source exists; the country is
  still asked when sources are missing or disagree (justified: legally relevant, a wrong guess is worse than one
  question).
- **Can the user always tell what to do next:** yes — one dominant button per screen; the source of each
  prefilled value is shown in plain words.
- **Friction:** down (no step or field added; an inferred value never removes the supplier's ability to change it).

## Out of scope
"Your assistant can do this" (follow-up 2), CI/PR-template enforcement, any change to verification, terms,
checklist semantics, `registerPartnerOrg`/`PATCH /company` validation, reverse-geocoding, IP geolocation (not used:
unreliable and privacy-sensitive), fetching the website to infer country outside the existing AI setup path.

## Tests
- Gateway Jest: `inferCompanyFacts` table tests (ccTLD map incl. `.co.uk`, vanity/generic → null, `www.`/subdomain,
  uppercase, VAT prefixes incl. `EL`, conflict → null, free-mail → null, unconfirmed email → null, stored wins);
  route test (401 unauthenticated, 403 orgId of another org, read-only — no write call on the mock, response has
  no internal fields); MCP status test (suggestion present when missing, absent when stored, next_action text).
- Vitest: registration (prefill + confirm line + Change reveals select + suggestion failure → today's behaviour),
  profile sheet (summary mode, Change, Save sends exactly the shown values, missing value shows input), AI review
  fallback order; existing SetupHub/registration tests stay green.
- Staging (read-only, `docs/validation/<VTID>/staging-tests.json`): gateway GET `company-suggestions` as the test
  user returns 200 with the documented shape; frontend spec opens the registration sheet or the profile sheet
  (whichever the test user's state allows) and asserts the prefilled values/confirm line — no submit; the network
  guard blocks every non-GET.
## Delivery
One VTID for both repos (one feature; precedent: VTID-05204), one PR per repo, an evidence pack in each.
**Merge order: gateway first** — its STAGING-VERIFY proves the new routes; then the frontend PR. The frontend is
safe before the routes exist: `fetchCompanySuggestions` failure → today's behaviour. Gate 2 covers both
releases (the gateway commit range and the frontend commit range listed separately).
<!-- plan:end -->

## Round 1 — partner findings (verbatim)

## Verified premises

- **Claim:** Registration step 2 (`RegisterOrgDialog.tsx`) asks name, website (optional, empty), country select preselected from `guessCountry` in `commerce-countries.ts`.
  TRUE -- `RegisterOrgDialog.tsx:42` imports `guessCountry` from `@/lib/commerce-countries`; line 109 calls `guessCountry()` as the preselect; step 1 (line 232) shows name, website (optional per line 248-249), and country select (line 274). Website starts empty (`EMPTY_FORM` at line 48: `website: ''`).

- **Claim:** Setup hub Business profile row uses `ProfileSheet` at ~L585-680 with website + country select, saves via `PATCH /api/v1/partner-onboarding/:orgId/company`.
  TRUE -- `SetupHub.tsx:581` defines `ProfileSheet`; line 612 calls `adminFetch(\`${PARTNER_ONBOARDING_API}/${orgId}/company\`, { method: 'PATCH', ... })`. The sheet has website input (line 639) and country select (line 651). Line range is 581-682.

- **Claim:** `FREE_EMAIL_DOMAINS` exists in `services/partner-verification.ts` and is an exported `ReadonlySet<string>`.
  TRUE -- `services/gateway/src/services/partner-verification.ts:112`: `export const FREE_EMAIL_DOMAINS: ReadonlySet<string> = new Set([...])`. Existing import pattern from other services files confirmed (e.g., `partner-onboarding-service.ts:45`).

- **Claim:** AI setup review uses `reviewFromDraft` from `commerce-ai-setup.ts`; country = what the AI read else `guessCountry()` fallback.
  TRUE -- `AiSetupSheet.tsx:46` imports `reviewFromDraft`; line 101 calls `setReview(reviewFromDraft(d, guessCountry()))`. `commerce-ai-setup.ts:75-81` shows `reviewFromDraft` uses `draft.business.country ?? fallbackCountry`.

- **Claim:** Commerce MCP `update_business` takes country/website; the status the AI reads has no suggestion field.
  TRUE -- `commerce-mcp.ts:146-155`: `update_business` tool with `country` and `website` properties. `shapeStatus()` at lines 389-434 returns `country: org.country ?? null` and the `supplier_data` block with `website`, but no `suggested` field exists today.

## Findings

F1 [minor] Email confirmed status requires I/O the plan does not explicitly mention

The pure helper `inferCompanyFacts` takes `emailConfirmed` as input, but the plan's route description does not say how it gets that boolean. The JWT (`auth-supabase-jwt.ts:41-55`) does not carry `email_confirmed_at`. The gateway already has `readEmailConfirmation()` in `partner-verification-io.ts:79-82` which calls `supabase.auth.admin.getUserById(userId)` -- a DB round-trip. The plan should note this I/O dependency in the route implementation, even though the helper itself stays pure.

Evidence: `services/gateway/src/middleware/auth-supabase-jwt.ts:41-55` (no `email_confirmed_at` on `SupabaseIdentity`); `services/gateway/src/services/partner-verification-io.ts:79-82` (existing pattern for reading it).

Suggestion: Explicitly state the route calls `readEmailConfirmation()` (or equivalent) to get the confirmed flag before passing it to the pure helper.

F2 [minor] The route uses `requireOrgAdmin()` but with `orgId` as a query param, not a path param

The plan says "optional `orgId` query -> only with org-admin of that org, else 403". The existing `requireOrgAdmin()` middleware (`routes/partner-orgs.ts:90-105`) reads `req.params.orgId` (line 98), which only works for path parameters (`:orgId`). Since the plan's route uses a query parameter (`?orgId=...`), `requireOrgAdmin()` cannot be used directly -- custom auth logic is needed.

Evidence: `services/gateway/src/routes/partner-orgs.ts:98`: `const orgId = req.params.orgId;`

Suggestion: Either mount the route as `GET /company-suggestions/:orgId` (matching the existing pattern) or state that org-admin authorization is done inline in the handler (reading from `req.query.orgId`). The former is cleaner and reuses middleware.

F3 [minor] The ccTLD-to-country mapping should handle `.co.uk` two-part TLDs carefully

The plan mentions `.co.uk`/`.uk` -> GB in the test list, which is good. But the plan's "fixed allowlist of real ccTLDs" approach needs to specify how multi-part TLDs like `.co.uk`, `.com.au`, `.co.nz` are parsed (they require parsing the second-level domain, not just the TLD). The pure helper needs to decide: does `example.co.uk` produce `GB` from `.uk` or from `.co.uk`?

Evidence: Plan line 28 mentions `.co.uk`/`.uk` -> GB but does not specify the parsing algorithm for multi-part TLDs.

Suggestion: State that the helper uses a short explicit map for known multi-part ccTLDs (`.co.uk`, `.com.au`, `.co.nz`, `.com.br`, etc.) checked BEFORE single-segment TLD extraction, or use a public suffix list. The test table already covers it; just clarify the implementation approach.

F4 [minor] One VTID across two repos may complicate the evidence/validation structure

The plan says "one VTID covering both repos" but each repo has its own PR, its own CI, its own `docs/validation/<VTID>/` directory, and its own STAGING-VERIFY workflow. This is workable but the plan should clarify: which repo's PR is merged first (gateway, since the frontend depends on the new route), and that the frontend PR can be opened and tested before the gateway route is on staging (since `fetchCompanySuggestions` returns `{ country: null, website: null }` on failure, matching today's behavior).

Evidence: Plan line 110; both repos' CLAUDE.md describe independent STAGING-VERIFY pipelines.

Suggestion: Specify merge order: gateway first (route must exist for staging tests to GET it), then frontend. One VTID, two PRs, evidence packs in both.

F5 [minor] MCP `shapeStatus` change needs the caller's auth email for inference -- `shapeStatus` currently receives only `body` and `portalUrl`

The plan says the MCP status will add `suggested: { country?, website? }` when country or website is missing. But `shapeStatus()` (`commerce-mcp.ts:389`) receives `(body, portalUrl)` -- it has no access to the caller's email or email-confirmed status. To infer suggestions, the MCP handler needs to pass additional context (the caller's email and confirmed flag) into `shapeStatus` or into a separate call before shaping.

Evidence: `services/gateway/src/services/commerce-mcp.ts:389`: `export function shapeStatus(body: Record<string, any>, portalUrl: string)`

Suggestion: Specify that the MCP `get_onboarding_status` handler passes the caller's email/confirmed-flag alongside `body` to a new function (or an extended `shapeStatus` signature), so inference can run. The pure helper is fine; the wiring at the call site needs a word.

F6 [major] The new route `GET /api/v1/partner-onboarding/company-suggestions` will shadow the existing `GET /:orgId` route if the router matches `company-suggestions` as an `orgId`

Express route matching is order-dependent. The existing route at `partner-onboarding.ts:247` is `router.get('/:orgId', requireAuth, requireOrgAdmin(), ...)`. If the new `company-suggestions` route is added AFTER this line, `GET /api/v1/partner-onboarding/company-suggestions` will match `/:orgId` first (with `orgId = 'company-suggestions'`), fail the `requireOrgAdmin()` check (not a valid UUID), and return 403 -- the new route will never be reached.

Evidence: `services/gateway/src/routes/partner-onboarding.ts:247`: `router.get('/:orgId', requireAuth, requireOrgAdmin(), async (req: Request, res: Response) => {`

Suggestion: The new route MUST be registered BEFORE the `/:orgId` catch-all in the same router, or mounted on a different path prefix (e.g., `GET /api/v1/partner-onboarding-suggestions`). Specify the insertion order explicitly.

## Questions for the planner

1. For the MCP status enrichment with `suggested`, where does the caller's email come from at the `shapeStatus` call site? The MCP handler has the authenticated request but `shapeStatus` does not receive it today. Will you extend the signature or compute suggestions in the handler before calling `shapeStatus`?

2. The plan says "Confirmed account email domain" is a source. Does the Supabase JWT's `email` claim always represent a confirmed email, or does the route need an explicit `email_confirmed_at` check? (The JWT does not carry this flag; `readEmailConfirmation()` exists but is an I/O call.)

3. For the single-VTID-two-repos approach: is there a precedent in this codebase, or is this the first time? If it has been done before, what was the experience?

## Verdict

NOT CONVERGED

F6 is a major finding: the route ordering issue with Express's `/:orgId` catch-all means the proposed route path will not work without explicit ordering or a path change. The plan should address this before implementation.

## Round 1 — planner responses

- F1 ACCEPTED — the routes and the MCP handler call the existing `readEmailConfirmation()`; unconfirmed or
  unavailable → no email-domain suggestion.
- F2 ACCEPTED — the org variant is now a path route `GET /:orgId/company-suggestions` with the existing
  `requireOrgAdmin()`; no query-param auth.
- F3 ACCEPTED — explicit multi-part suffix map checked before the last label; tests cover `.co.uk`, `.com.au`.
- F4 ACCEPTED — "Delivery" section: one VTID, two PRs, gateway merges first, frontend degrades to today's
  behaviour until the routes exist; Gate 2 lists both ranges.
- F5 ACCEPTED — the handlers compute the suggestion and pass it as an optional third argument of `shapeStatus`.
- F6 ACCEPTED — the caller-only route is registered before `router.get('/:orgId')`, with a route test asserting
  it is reachable (not captured by `/:orgId`).
- Q1 — answered by F5.
- Q2 — the JWT `email` claim is not proof of confirmation; `readEmailConfirmation()` is used (F1).
- Q3 — precedent: VTID-05204 (one VTID, `exafyltd/vitana-platform#4125` + `exafyltd/vitana-v1#1427`), worked
  with an evidence pack per repo.

## Round 2 — partner re-review (verbatim)

## Round 1 findings — disposition

- F1 [minor] Email confirmed status requires I/O: **closed** -- plan now explicitly states both routes and the MCP handler call `readEmailConfirmation()` (lines 55-57), and names the source (`partner-verification-io.ts`).
- F2 [minor] `requireOrgAdmin()` with query param: **closed** -- plan now splits into two routes: `GET /company-suggestions` (no org, requireAuth only) and `GET /:orgId/company-suggestions` (path param, existing `requireOrgAdmin()`). Both patterns match the existing codebase.
- F3 [minor] Multi-part TLD parsing: **closed** -- plan lines 29-31 now explicitly describe "short explicit map BEFORE the last label is read" with examples. Test coverage stated.
- F4 [minor] One VTID across two repos: **closed** -- plan lines 120-124 specify merge order (gateway first), degradation behavior, and cite VTID-05204 as precedent. Verified: `docs/validation/VTID-05204/plan-sparring.md` exists in the platform repo.
- F5 [minor] MCP `shapeStatus` signature: **closed** -- plan lines 59-65 specify `readEmailConfirmation(ctx.caller)` in the handler, inference before shaping, and an optional third argument to `shapeStatus`. Existing callers unchanged.
- F6 [major] Route ordering with `/:orgId` catch-all: **closed** -- plan line 51-52 now states the route is "registered before `router.get('/:orgId', ...)`" with a route test asserting the order. Verified: `partner-onboarding.ts:247` is the `/:orgId` route; adding the new route before it in the same file is the correct fix.

## Round 1 questions — disposition

- Q1 (MCP email source): **closed** -- answered by F5 acceptance.
- Q2 (JWT email vs confirmed): **closed** -- plan confirms `readEmailConfirmation()` is used, not the JWT claim.
- Q3 (one-VTID-two-repos precedent): **closed** -- VTID-05204 confirmed as precedent.

## Verified premises (round 2, new checks)

- **Claim:** `readEmailConfirmation` returns both email and confirmed status in one call.
  TRUE -- `services/gateway/src/services/partner-verification-io.ts:74-84`: returns `{ status: 'confirmed' | 'unconfirmed' | 'unavailable', email: string | null }`.

- **Claim:** The partner-onboarding router is mounted at `/api/v1/partner-onboarding` and route ordering within the file controls matching.
  TRUE -- `services/gateway/src/index.ts:1237`: `mountRouterSync(app, '/api/v1/partner-onboarding', partnerOnboardingRouter, ...)`. Express routers match routes in registration order within the same router instance.

- **Claim:** VTID-05204 precedent for one VTID across two repos.
  TRUE -- `vitana-platform/docs/validation/VTID-05204/plan-sparring.md` exists. Plan line 140 cites PR numbers (`#4125` + `#1427`).

## New findings

None. The revised plan addresses all round 1 findings cleanly. The route split (caller-only vs org-scoped), the explicit `readEmailConfirmation()` wiring, the multi-part TLD handling, the merge ordering, and the route registration order are all specified with enough precision for implementation.

## Questions for the planner

None.

## Verdict

CONVERGED

All six round 1 findings are closed. No new blocker or major introduced by the revision. The plan is precise about route ordering, auth patterns, I/O dependencies, merge sequencing, and MCP wiring -- all verified against the codebase.

## Verdict

CONVERGED after 2 rounds. Owner approved 2026-10-15 in session ("Approved."), with the constraints listed above.
