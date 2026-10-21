# VTID-04486 — Commerce partner onboarding Phase 1: `POST /partner-onboarding/:orgId/verification/check`

Spec §7 of `docs/COMMERCE-SELF-SERVICE-PARTNER-ONBOARDING-SPEC.md`: the automated verification checks, and the checklist's `verification` step.

## What changed

- **`POST /api/v1/partner-onboarding/:orgId/verification/check`** (org_admin only) runs the checks the engine can run today:
  - **Level 0:**
    - The org owner's email is confirmed (Supabase `email_confirmed_at`).
    - The website is proven to belong to the partner, by the first of these that works:
      - the website's domain is the owner's email domain, or a subdomain of it (never for mailbox providers such as gmail.com);
      - a DNS TXT record `_vitana-verification.<host>` = `vitana-verification=<token>`;
      - a `<meta name="vitana-site-verification" content="<token>">` tag, fetched through the existing SSRF-guarded fetcher.
  - **Level 1:**
    - The EU VAT id is looked up in VIES (REST API, 8 s timeout). Greece is sent as `EL`.
    - The VAT id is not required outside the EU.
    - Business verification is always reported `not_configured`, because spec Q2 (Stripe Connect vs VIES + billing mandate) is open.
  - **Level 2:** licence proof is always reported `not_configured`, because spec Q6 is open. The DPA is its own checklist step.
- **Step status:**
  - `done` when the level reached is at least the level the partner type requires;
  - `failed` when a relevant check failed (e.g. VIES says the number is invalid);
  - otherwise `in_progress`, with machine-readable `missing` codes.
  - A VIES outage is `unavailable`, which is retryable and never a failure.
- **Result:**
  - Stored as the `verification` row in `partner_onboarding_steps`, together with the facts it checked and the ownership token (reused across checks).
  - `trust_level` is set to the level reached (0 when none, the column's floor). It goes down too.
  - A level is never credited for a check that did not run.
  - The response adds `verification` to the usual state, including DNS/meta instructions while ownership is unproven.
- **Checklist:** a verification row is void (`todo`, `facts_changed`) once the org's website, country or VAT id differ from what was checked.
- **Consequence, stated plainly:**
  - Only an `affiliate_brand` (level 0) can finish this step today.
  - Shops and service providers (level 1) and labs/practitioners (level 2) stop at `business_verification_not_configured` / `licence_verification_not_configured` until the owner decides Q2/Q6.

## Acceptance criteria

AC-1 Levels and step status:
- level 0 needs email + domain;
- level 1 adds VAT (or non-EU) + business verification;
- level 2 adds licence;
- an unrun check is never credited;
- an invalid VAT id fails the step;
- a VIES outage is retryable;
- `missing` names only the levels the type needs.
TEST: services/gateway/test/vtid-04486-partner-verification.test.ts

AC-2 Ownership proof:
- the email domain or a subdomain matches, never for mailbox providers;
- the TXT record is found split or whole;
- the meta tag is found in either attribute order;
- the instructions name the exact record and tag.
TEST: services/gateway/test/vtid-04486-partner-verification.test.ts

AC-3 The VIES client:
- valid, with the registered name (`---` → null);
- invalid only on `INVALID` / `INVALID_INPUT`;
- any other verdict, HTTP error or network error is `unavailable`, never a throw.
TEST: services/gateway/test/vtid-04486-partner-verification.test.ts

AC-4 The checklist voids a verification result when the website, country or VAT id changes.
TEST: services/gateway/test/vtid-04486-partner-verification.test.ts

AC-5 The route:
- org_admin only, 401 JSON without a token;
- 409 `NOT_CHECKABLE` for a rejected org, with nothing recorded;
- a shop proves ownership by email domain, passes VIES and stops at `business_verification_not_configured`;
- the step row carries facts, the registered name and `onConflict`;
- an affiliate brand with a gmail address proves ownership by TXT and finishes at level 0 (`done` in the checklist);
- the token is stable and the instructions are returned;
- an invalid VAT fails the step;
- an unconfirmed email reaches no level and lowers `trust_level`.
TEST: services/gateway/test/partner-onboarding-verification.test.ts

## Route mount

ROUTE_MOUNT: the existing `mountRouterSync(app, '/api/v1/partner-onboarding', …)` (VTID-04478). This adds `router.post('/:orgId/verification/check', …)` to that router.
FINAL_URL: `https://preview-aws-gateway.vitanaland.com/api/v1/partner-onboarding/<orgId>/verification/check` (staging, after merge).
CURL_PROOF: **not yet run.** The handler is new and deployed nowhere.
- **Before merge:** `test/partner-onboarding-verification.test.ts` exercises the real router with supertest.
- **After the staging deploy:** `curl -s -o /dev/null -w "%{http_code} %{content_type}" -X POST https://preview-aws-gateway.vitanaland.com/api/v1/partner-onboarding/00000000-0000-0000-0000-000000000000/verification/check` should return `401 application/json`.
CURL: see CURL_PROOF above.

## OASIS

OASIS_IMPACT: yes. New topic `partner_org.verification_checked`. The payload is `partner_organization_id`, `level_required`, `level_reached`, `step_status`, the per-check statuses and `domain_method`. The VAT id, the email and the registered name are not in the payload; they stay in the step row.

OASIS_PROOF: the route suite asserts the event and that its payload holds neither the VAT number nor the email. Once deployed, check with:
`SELECT topic, metadata->>'level_reached', metadata->>'step_status' FROM oasis_events WHERE topic = 'partner_org.verification_checked' ORDER BY created_at DESC LIMIT 5;`

## Not verified here

- **VIES is not reachable from this session** (the egress proxy returns 403). The client follows the documented REST shape (`GET /ms/{cc}/vat/{number}` → `isValid`, `userError`, `name`) and is tested against it with an injected fetch. The first real call happens on staging.
- DNS TXT and meta-tag lookups against a real domain have not been run.

## Not in this VTID

- `submit` does not run these checks itself; the partner (or the wizard) calls `verification/check` first.
- The business-verification provider (Q2) and licence sources (Q6) are owner decisions.
- The network-advertiser-ID check for network-sourced brands is not built.
- No schema change: `detail` is existing JSONB and `trust_level` an existing column.
