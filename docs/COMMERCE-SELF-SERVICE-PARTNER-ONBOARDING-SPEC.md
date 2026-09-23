# Vitanaland Commerce — Self-Service Partner Onboarding (Specification)

**VTID:** VTID-04330
**Status:** Draft for review. Product decisions approved (2026-09-23); legal, compliance and accounting items are open (§14).
**Scope:** `exafyltd/vitana-platform` (gateway, database) and `exafyltd/vitana-v1` (landing page, partner workspace)
**Supersedes, when implemented:** the operator-run steps in `docs/MERCHANT_ONBOARDING_RUNBOOK.md` and the manual `partner_registry` seeding pattern (VTID-03885)

---

## 1. Goal

Any business can connect to Vitanaland **by itself — simply, conveniently, with no Vitana staff involved**:

- **preferably through an AI agent** (Vitana's own onboarding assistant, or the partner's own AI tool);
- or, if the partner prefers, **by filling in a step-by-step form**.

Vitana staff are involved only for **exceptions** that automated rules cannot decide (§10). A standard connection goes from first visit to live without anyone at Vitana touching it.

This implements the long-term vision in `CLAUDE.md` §13c ("any business connects to Discover … without an engineer hand-writing a SQL migration").

## 2. Decisions (approved 2026-09-23)

| # | Decision |
|---|---|
| D1 | **Self-service by default.** No admin approval in the standard path. Automated checks decide go-live; anything ambiguous goes to a review queue. |
| D2 | **Health results: automatic processing with an exception/review queue.** Standard, validated results flow automatically. Review is required for ambiguous identity matches, missing consent, invalid data, duplicates, and other exceptions. The exact rules are confirmed with legal/compliance. |
| D3 | **Stripe Connect** is the initial verification and payout provider, subject to the final legal and accounting setup. |
| D4 | **Launch commerce stays affiliate/redirect-based.** Vitana lists products and services in Discover and redirects the user to the partner for the purchase. Vitana does **not** take payment for the underlying transaction. |
| D5 | **Vitana earns a commission** on attributed sales. |
| D6 | **MAXINA community members earn money through recommendations** of eligible products when a purchase is attributed to their recommendation. |
| D7 | **Partner types:** Lab / diagnostics, Shop / supplier, Practitioner / clinic, Brand / affiliate, plus Service provider (gyms, spas, retreats). |

## 3. Current state (as of `main` @ `dd07c2b`, 2026-09-23)

### 3.1 Four unlinked partner identities
One business can end up as four records that do not know about each other:

| Record | Created by | Ownership | Link to the others |
|---|---|---|---|
| `partner_organizations` (+ `_members`, `_invites`) — VTID-03932/03974 | `POST /api/v1/partner-orgs/register` | Team with roles `org_admin` / `staff` / `professional` | → `partner_registry` only, only for `commerce_vertical='health'`, only on admin activation |
| `partner_registry` — VTID-03885 | Admin activation, or engineers in migrations | none | `partner_organization_id` FK |
| VCAOP `partner_tenant` + `integration_manifest` | `POST /api/v1/vcaop/portal/my/connections` | Single `owner_user_id` | none to orgs |
| `merchants` (+ `products`) — VTID-02000/03894 | `POST /api/v1/vcaop/portal/my/merchants` | Single `owner_user_id` | `partner_tenant_id` column, unused by orgs |

### 3.2 Steps that still need Vitana staff
| Step | Where | Who acts today |
|---|---|---|
| Activate an organization | `POST /partner-orgs/:orgId/activate` (`routes/partner-orgs.ts`) | exafy_admin only; does not check the current status, so a `rejected` org can be activated |
| Take a connection live | `POST /vcaop/portal/connections/:id/approve-activation` (`routes/vcaop-portal.ts`) | admin only |
| Supplier catalogue | `merchants.onboarding_status` | never moves past `draft`; not in the admin PATCH allowlist either |
| Affiliate brands (Awin, Admitad, DoctorBox, Amazon.ae, CJ) | migrations + Command Hub runbook | engineer / operator |
| Shopify one-click connect | `services/shopify-oauth.ts` | built, dormant: no `SHOPIFY_CLIENT_ID/SECRET` in any deploy workflow |
| AI-agent connect | `services/vcaop-mcp` | not publicly reachable (BLK-006); end-user read tools, not a partner API |
| Team invites | `POST /partner-orgs/:orgId/members/invite` | token returned to the client; **no email is sent**; the admin shares the link by hand |
| Lab capabilities | `partner_registry.capabilities` | all `false` for self-registered orgs |

### 3.3 Security defects found during analysis
| ID | Defect | Where |
|---|---|---|
| SEC-1 | Invite accept does not compare the caller's email with the invited email. Anyone holding the token joins with that role. | `routes/partner-orgs.ts` `POST /invites/:token/accept` |
| SEC-2 | The `partner_organization_members` SELECT policy queries the same table inside its own policy (likely infinite recursion for any browser read; the gateway is unaffected because it uses the service role). | `supabase/migrations/20260915120000_vtid_03932_partner_organizations.sql` |
| SEC-3 | `/activate` has no status guard. | `routes/partner-orgs.ts` |
| SEC-4 | Access tokens stored in plaintext (`partner_oauth_credential`, `marketplace_sources_config`). | VCAOP migration 0006; VTID-02000 |
| SEC-5 | Catalogue ingest uses one platform-wide `INGEST_API_KEY`, which cannot be scoped to a partner. | `routes/catalog-ingest.ts` |

### 3.4 Frontend (`vitana-v1`)
- **`/commerce/join` is not a landing page.** It is a single dark email/password card. The value proposition sits behind login in `CommercePortal`.
- **Two password-only login screens.** `/commerce-login` has no signup, no password reset and no magic link. The public `Index.tsx` links to it.
- **Hardcoded tenant in signup:** `tenant_slug:'maxina'`. The email-confirmation redirect is always `/commerce`, so invite context is lost.
- **The main call to action does not work.** "Connect via AI agent" is labelled "Going live soon" (BLK-006).
- **The merchant surface is desktop-only.** `CommercePortal.tsx` wraps it in `hidden lg:block`.
- **Merchants cannot manage anything after onboarding:** products are write-only, and there are no orders, earnings or analytics.
- **The lab workflow is an admin tool.** It uses raw status enums and raw JSON result upload, resolving the inbox needs typed UUIDs, and `hasFullAccess` is computed across any org rather than the active one.
- **Onboarding forms leak internal fields:** free-text `org_type`, `org_key` slugs and an OpenAPI textarea.
- **Overlapping entry points:**
  - `/business` (Business Hub, mock data) vs `/commerce` vs `/professional`;
  - the org role "professional" vs the platform role `professional`;
  - admin duplicates of connections and health orders.

### 3.5 Money flow pieces that already exist
| Piece | Where | State |
|---|---|---|
| Click redirect with `click_id` and `attribution_recommendation_id` | `routes/click-redirect.ts` (`GET /r/:product_id`) | works |
| Awin conversion pull via `clickref` | `services/marketplace-sync/awin-order-sync.ts` | works |
| Admitad postback with `subid` | `routes/vcaop-postback.ts` | works |
| Recommender revenue share (default 20% of Vitana's commission, never more) credited to the wallet | `services/recommendation-commissions/credit-recommender.ts` (VTID-02950) | works for converted orders with `commission_cents` |
| Stripe Connect onboarding and webhooks | `routes/creators.ts` (`/onboard`, `/status`, `/dashboard`), `routes/stripe-connect-webhook.ts` (VTID-01231) | built for creators; reusable |
| Commission confirm/reverse | `routes/vcaop.ts` `commissions/:id/confirm|reverse` | admin-only, manual |

**Gap:** a partner that is not on Awin or Admitad **has no way to report a sale**. For such a partner Vitana earns nothing, and neither does any recommending member.

---

## 4. Principles

1. **One partner account.** Every record for a business hangs off one `partner_organizations` row.
2. **One onboarding engine, three ways in.** The assistant, the partner's own agent and the step-by-step form all call the same API and share saved progress. A partner can switch between them mid-way.
3. **Automated checks replace admin approval.** Go-live is a rule over verified facts, never an admin click.
4. **Where a person is required, it is the partner.** The VCAOP human gate (`services/vcaop/src/guardrails/human-gate.ts`: KYB, bank link, irreversible submit) stays. The human is the partner's own officer, never Vitana staff.
5. **Exceptions, not approvals.** Vitana sees only what rules cannot decide (§10).
6. **Monitoring after go-live replaces review before it.** Broken feeds, complaints, failed tracking or policy hits pause automatically; the partner is notified and fixes it themselves.
7. **No internals in the UI.** No slugs, enums, UUIDs, JSON or OpenAPI in any partner-facing step, except an explicit developer area.
8. **Repo rules apply.** i18n (German first), RTL support, LLM calls through Bedrock with the user's locale injected, and no hardcoded spoken sentences for any voice path (CLAUDE.md NEVER rule 41).

---

## 5. Partner account model

### 5.1 Root entity
`partner_organizations` is the root. The following are added:

| Change | Detail |
|---|---|
| `partner_type` | New column, CHECK `lab \| supplier_shop \| practitioner_clinic \| service_provider \| affiliate_brand`. Replaces free-text `org_type` in the UI. `commerce_vertical` is derived (`lab`, `practitioner_clinic` → `health`; the rest → `general`) and kept for compatibility. |
| `lifecycle_state` | See §5.2. Replaces the ad-hoc `status` (`pending_review\|active\|suspended\|rejected`); the old column is kept in sync until the frontend is migrated. |
| `country`, `vat_id`, `website`, `legal_name` | Company facts collected during onboarding (moved out of `business_details` jsonb for the fields rules depend on). |
| `trust_level` | `0\|1\|2`, computed (§7). |
| `merchants.partner_organization_id` | FK. Every supplier merchant belongs to an org. |
| VCAOP `partner_tenant.partner_organization_id` | FK. Every connection belongs to an org. |
| Backfill | Every existing `merchants.owner_user_id` / `partner_tenant.owner_user_id` without an org gets a one-member org (owner = `org_admin`). |

### 5.2 Lifecycle
```
draft → submitted → verifying → live
                       │           │
                       ├→ needs_action (partner must fix; loops back to verifying)
                       ├→ exception    (Vitana review queue, §10)
                       └→ rejected
live → paused (automatic, recoverable by the partner) → live
live → suspended (Vitana, exception outcome)
```
- Transitions are enforced in one gateway service (a pure function over the current state, the same pattern as VCAOP's `canTransition`). Every transition emits an OASIS event and an email to the org admins.
- `live` is reached automatically when every step required by the partner type (§6) is complete and every check (§7) passes.

### 5.3 Roles inside an organization
| Role | Replaces | Can |
|---|---|---|
| `owner` | `org_admin` (creator) | everything, including billing and deleting the org |
| `admin` | `org_admin` | everything except billing and deleting |
| `manager` | `staff` | catalogue, orders, tracking, results |
| `practitioner` | `professional` | orders and results assigned to them |

"Practitioner" replaces "professional" in the org to end the name clash with the platform `professional` role.

---

## 6. Onboarding engine

### 6.1 Checklist
Each org has a checklist computed from `partner_type`. Each step is `todo | in_progress | done | failed | not_required`.

| Step | Lab | Shop | Practitioner | Service | Brand |
|---|---|---|---|---|---|
| account (verified email) | ✓ | ✓ | ✓ | ✓ | ✓ |
| company (legal name, country, VAT, website) | ✓ | ✓ | ✓ | ✓ | ✓ |
| verification (§7) | L2 | L1 | L2 | L1 | L0/L1 |
| catalogue (products, panels or services) | panels | products | services | services | network feed |
| mapping confirmed (categories, preview) | ✓ | ✓ | ✓ | ✓ | ✓ |
| sales tracking test passed (§8) | – | ✓ | – | ✓ | ✓ |
| results channel test passed | ✓ | – | – | – | – |
| terms accepted (commission rate, partner terms) | ✓ | ✓ | ✓ | ✓ | ✓ |
| data processing agreement signed | ✓ | – | ✓ | – | – |
| billing mandate (direct partners, §9.2) | – | direct only | – | direct only | – |
| team invited | optional | optional | optional | optional | optional |

### 6.2 API (gateway, new)
All endpoints require an authenticated user and are owner/admin-scoped by org membership. Base path: `/api/v1/partner-onboarding`.

| Method | Path | Purpose |
|---|---|---|
| POST | `/start` | Create a `draft` org for the caller with `partner_type`. Idempotent per user + type while in `draft`. |
| GET | `/:orgId` | Org, lifecycle state, trust level, checklist with per-step status and the next recommended step |
| PATCH | `/:orgId/company` | Company facts; triggers the relevant checks |
| POST | `/:orgId/detect` | Website → platform detection (reuses `services/platform-detect.ts`), company pre-fill |
| POST | `/:orgId/catalogue/*` | Product, panel or service CRUD, CSV upload, feed URL — wraps the existing `/vcaop/portal/my/products` logic |
| POST | `/:orgId/connections` | Shop or API connection — wraps the VCAOP `/my/connections` state machine |
| POST | `/:orgId/tracking/test` | Start the tracking round-trip test (§8.3); GET for its status |
| POST | `/:orgId/terms/accept` | Record acceptance (version, timestamp, user, IP) |
| POST | `/:orgId/dpa/sign` | E-signature of the data processing agreement |
| POST | `/:orgId/billing/mandate` | Create a Stripe SetupIntent for SEPA/card; the webhook completes the step |
| POST | `/:orgId/verification/connect` | Create or resume a Stripe Connect account-link (§7) |
| POST | `/:orgId/submit` | `draft → submitted`; the engine then runs checks and moves the state itself |

The **VCAOP activation gate** (`approve-activation`) is replaced for self-service connections by the engine's own rule: certified mapping + passed tracking test + org `live`. The admin endpoint stays as an exception tool.

### 6.3 Three ways in

**A. Vitana onboarding assistant (primary).**
- A chat assistant, with optional voice, on the landing page and in the workspace.
- LLM routing: a new `partner_onboarding` stage in `llm_routing_policy`, Bedrock primary (ALWAYS rule 10a). The partner's locale is injected into the system prompt.
- Its tools are the §6.2 endpoints and nothing else. It can never approve itself, bypass a check, or act without the partner's confirmation on any step that publishes, signs or accepts.
- Typical flow: "What's your website?" → detection and pre-fill → the right connect option for the platform (one click for Shopify) → catalogue mapping preview → tracking test guidance → terms → submit.
- It can start **before an account exists**. The account is created mid-conversation with a magic link and the conversation continues after sign-in.

**B. Partner's own AI agent.**
- A partner-scoped MCP server exposing the same §6.2 operations as tools, authorized with the partner's own login via OAuth 2.1 (extending the `services/vcaop-mcp` authorization server).
- Scopes `partner:onboarding:*`, `partner:catalogue:*`, `partner:orders:read`.
- Depends on BLK-006 (public DNS), so it ships after A and C.

**C. Step-by-step form.**
- The same checklist as a wizard: one question per screen, progress saved, works on a phone, no internal fields.

---

## 7. Verification and trust levels

| Level | Required for | Automatic checks | Human step (partner only) |
|---|---|---|---|
| 0 | Brand/affiliate listing via a known network | Verified email; website domain matches the email domain or an ownership proof (DNS TXT or meta tag); network advertiser ID resolves | none |
| 1 | Shop, service provider, direct brand | Level 0 + EU VAT via VIES (or the company register where an API exists) + Stripe verification of the business (D3) | Completing Stripe's hosted onboarding |
| 2 | Lab, practitioner, clinic | Level 1 + licence/accreditation proof (registry lookup where available, otherwise document upload with an automated plausibility check) + signed DPA | Uploading documents, signing the DPA |

- **Stripe Connect (D3).** At launch partners are not paid by Vitana (D4). Connect is used for member payouts (§9.3) and, if accounting confirms, for business verification of partners. Whether partners get a Connect account purely for verification, or are verified through VIES + the billing mandate, is open question Q2 (§14). The engine treats "business verified" as one fact with pluggable providers so either answer fits.
- **Catalogue content scan (all levels).** Automated rules check prohibited categories, unsubstantiated health claims (especially supplements), broken or non-matching product links and missing prices. Findings put items on hold, not the whole org.
- **Any failed or ambiguous check** → `needs_action` if the partner can fix it, otherwise `exception` (§10).

---

## 8. Sales tracking (affiliate/redirect, D4)

### 8.1 Flow
1. A member recommends a product. The share link carries `attribution_recommendation_id`.
2. A buyer clicks. `GET /r/:product_id` logs `product_clicks` with a `click_id` and redirects to the partner, appending the click ID in the parameter the partner's tracking method expects.
3. The buyer pays the partner. Vitana handles no payment.
4. The sale is reported back (§8.2) with the click ID, order ID, amount, currency and commission.
5. `product_orders` is upserted as `converted` with `commission_cents`. The recommender is credited via `creditRecommenderForOrder()` (existing, idempotent on `product_order_id`).
6. The commission stays **pending** until the return window closes or the network confirms (§9.1).

### 8.2 Reporting methods (chosen automatically per partner)
| Partner setup | Method | New work |
|---|---|---|
| Affiliate network (Awin, Admitad, CJ, Amazon) | Pull or postback, as today | Self-service advertiser-ID entry; generalize the `clickref`/`subid` handling for all networks |
| Shopify | Vitana Shopify app: reads the click ID from the landing URL into cart/order attributes and reports paid orders by webhook | Shopify app + credentials |
| WooCommerce | Vitana plugin, same approach | Plugin |
| Any other site | **Postback URL** or **signed webhook** (`POST /api/v1/partner-conversions/:orgId`, HMAC with a per-org secret generated in the workspace) or a **thank-you-page JS snippet** | New endpoint, secret management, snippet |
| Cannot integrate | **Per-recommender discount code**; sales reported with the code (manual monthly upload or API) | Code issuance + attribution by code |

Per-org conversion secrets and API keys replace the global `INGEST_API_KEY` for partner-originated calls (fixes SEC-5).

### 8.3 Tracking test (go-live gate)
1. The workspace generates a test click.
2. The partner completes a test order (or triggers a test event from their platform).
3. The engine checks that a correctly signed report with the matching click ID arrived.
4. On pass, the "sales tracking" step is `done`.

The same mechanism, with a test result file, gates the lab results channel.

---

## 9. Money

### 9.1 Commission states
`pending → confirmed → invoiced/collected → (paid to recommender)`, or `pending → reversed`.
- Auto-confirm after the partner type's return window (configurable; default 30 days) unless the partner or network reverses it.
- The admin `confirm|reverse` endpoints remain for exceptions only.

### 9.2 Collecting Vitana's commission
- **Network partners:** the network pays Vitana. No partner billing.
- **Direct partners:**
  - they accept the commission rate in the terms (§6.1) and set up a SEPA direct debit or card via Stripe (SetupIntent);
  - confirmed commissions are invoiced monthly and collected automatically through Stripe Billing/Invoicing;
  - a failed collection → `needs_action`, then automatic `paused` after a grace period.

### 9.3 Recommender earnings (D6)
- **Eligibility.** Per product: `recommender_share_enabled` (default from the partner type's policy). Partners can opt products in or out in the workspace and may add a bonus share on top of the platform default. The platform default rate stays centrally configured (`credit-recommender.ts`, default 0.2 of Vitana's commission).
- **States shown to members:** pending → available → paid out.
- **Cash-out:** Stripe Connect Express, onboarded by the member, reusing `routes/creators.ts` `/onboard` and `stripe-connect-webhook.ts`. Minimum cash-out amount is configurable.
- **Clawback.** A reversal after payout is netted against future earnings, never charged to the member's card.
- **Fraud rules** (→ §10): self-purchase through one's own link, click-farm patterns, abnormal conversion rates.

---

## 10. Exception queues (the only places Vitana staff act)

One admin screen, **Partner exceptions**, with three queues. Each item carries the reason, the evidence and the allowed resolutions. Every resolution is audited and emits an OASIS event.

| Queue | Flows automatically | Goes to review |
|---|---|---|
| **Onboarding** | All checks pass | Verification failed or ambiguous, licence not verifiable, catalogue policy hit the partner cannot fix, suspected duplicate org |
| **Health results** (D2) — extends `partner_health_result_inbox` | Unambiguous patient match, active consent, valid schema and values, not a duplicate | Ambiguous or no match, missing or revoked consent, invalid data, duplicates, other rule hits |
| **Commerce** | Known click ID, first report of the order, amount within bounds | Unknown click ID, duplicate order ID, reversal after payout, outlier amount or commission, self-referral, suspicious click patterns |

The exact health-result rules are configuration, not code constants, so legal/compliance can change them without a deploy (Q1). The existing `confirm-match` resolution is kept; unambiguous matches are confirmed automatically.

---

## 11. Landing page (`commerce.vitanaland.com`, `vitana-v1`)

Replaces `CommerceJoin` as the public entry. Light theme matching the redesigned workspace; all copy in i18n (DE first); works right-to-left.

1. **Hero.** Headline about reaching members who invest in their health; "live in minutes, fully self-service". Primary CTA **"Connect with the Vitana assistant"**; secondary **"Set up step by step"**; a "Sign in" link.
2. **"Who are you?"** Five partner-type tiles (§2 D7). Each shows what you get, what you need and a realistic time ("shops: about 10 minutes"; "labs: verification usually under a day"), and deep-links the chosen path with the type preselected.
3. **How it works.** Connect → Verify → Test → Live. The same four steps reappear as the progress bar in the workspace.
4. **How you earn and what it costs.** The commission model in plain words; how member recommendations drive sales.
5. **Integration options.** Stated honestly by availability: assistant, form, Shopify/WooCommerce, network ID, API/webhook, own AI agent ("coming soon" until BLK-006 is resolved).
6. **Trust.** Consent-first data sharing, GDPR, what partners see and never see about members.
7. **FAQ and contact.**

**Sign-in consolidation**
- One sign-in page with magic link (primary), password (fallback) and password reset.
- `/commerce-login` redirects to it; `Index.tsx` links to the landing page.
- `redirectTo` and invite tokens survive email confirmation.
- The hardcoded `tenant_slug:'maxina'` is removed.

---

## 12. Partner workspace after login (`vitana-v1`)

**Home**
- Before `live`: the onboarding checklist with the next step and the assistant docked.
- After `live`: KPIs for the partner type (clicks, attributed sales, commission, recommender-driven share; for labs: orders and results turnaround).

**Navigation by type**

| Section | Lab | Shop | Practitioner | Service | Brand |
|---|---|---|---|---|---|
| Orders / results | ✓ | – | assigned only | – | – |
| Catalogue / services | panels | products (list, edit, CSV) | services | services | read-only feed |
| Sales and commissions | – | ✓ | – | ✓ | ✓ |
| Tracking and connections | results channel | ✓ | – | ✓ | network |
| Team | admin | admin | – | admin | admin |
| Company, terms, billing | owner/admin | owner/admin | – | owner/admin | owner/admin |
| Developer (API keys, webhooks, sandbox) | admin | admin | – | admin | admin |

**Lab workflow**
- A plain-language status timeline instead of the enum dropdown.
- A results form and PDF upload instead of raw JSON.
- A patient picker (name, date of birth, order number) instead of typed UUIDs.
- Access scoped to the active org.

**Team**
- Invites are **emailed** and bound to the invited address (fixes SEC-1).
- Resend, revoke, role change and remove.
- The org switcher appears only for users in more than one org.

**Mobile parity.** Checklist, orders, catalogue editor, team and earnings all work on a phone. Only the developer area stays desktop-first.

**De-duplication**
- `/business` becomes the creator hub only (community members selling their own packages).
- The admin copies of connections and health orders move into the exception screen (§10).

---

## 13. Notifications
Email (plus in-app) to org admins on:
- every lifecycle transition;
- `needs_action`, with the exact fix;
- tracking test result;
- automatic pause;
- a failed billing collection;
- a new exception resolution.

Invitees get an email invite. Members get in-app/push notifications when earnings become available or are paid. All strings are catalog keys (`tt()`, CLAUDE.md §13b).

---

## 14. Open questions (legal, compliance, accounting)

| # | Question | Owner |
|---|---|---|
| Q1 | Exact health-result exception rules (match confidence threshold, consent states, duplicate definition, retention of quarantined data) | Legal / compliance |
| Q2 | Partner verification: Stripe Connect account for business verification only, or VIES + billing mandate | Accounting / Stripe |
| Q3 | Tax treatment and reporting of member recommendation earnings (income reporting; whether DAC7 or similar platform obligations apply) | Tax / legal |
| Q4 | Partner terms: commission rates per type, return windows, invoicing entity, VAT on commission invoices | Legal / accounting |
| Q5 | Disclosure requirements for member recommendations (advertising/affiliate labelling) | Legal |
| Q6 | Licence verification sources per country for labs and practitioners | Compliance |

None of these block the engine design: each is a configuration value or a pluggable provider.

---

## 15. Delivery phases

Each phase gets its own VTID and PR. Acceptance criteria are listed per phase.

### Phase 1 — Foundation and security fixes
- **Fix SEC-1..SEC-3:**
  - invite accept requires the caller's verified email to equal the invite email;
  - non-recursive members RLS policy (`SECURITY DEFINER` membership helper);
  - `/activate` status guard.
- Partner account model (§5): `partner_type`, `lifecycle_state`, company columns, org FKs on `merchants` / `partner_tenant`, backfill.
- Onboarding engine API (§6.2) with the lifecycle rule; OASIS events; emails.
- **Acceptance:**
  - a non-matching email cannot accept an invite;
  - a browser-authenticated member can read their own roster without error;
  - a `rejected` org cannot be activated;
  - a new org progresses `draft → live` with no admin call when all steps pass (integration test).

### Phase 2 — Sales tracking
- Conversion endpoint with per-org HMAC secret, postback URL, JS snippet, discount-code attribution, tracking test, auto-confirmation after the return window.
- **Acceptance:** a signed test conversion for a known click converts the order and credits the recommender exactly once; an unknown or duplicate conversion lands in the commerce exception queue.

### Phase 3 — Landing page, form and assistant (`vitana-v1` + gateway)
- New landing page, sign-in consolidation, step-by-step wizard, onboarding assistant; mobile parity.
- **Acceptance:** a shop reaches `live` through the form on a 390 px viewport; the assistant completes the same path using only §6.2 tools; DE/EN/AR (RTL) verified.

### Phase 4 — Money
- Stripe Billing mandate and monthly commission invoices for direct partners; member cash-out via Stripe Connect Express; per-product recommender settings.
- **Acceptance:** confirmed commissions produce one invoice per partner per month; a member with available earnings above the threshold can cash out after completing Connect onboarding.

### Phase 5 — Exception queues
- Unified exception screen; automatic health-result matching with configurable rules; commerce fraud rules.
- **Acceptance:** an unambiguous, consented, valid result is attached without review; each listed exception reason routes to the queue with its evidence.

### Phase 6 — Connectors and own-agent access
- Shopify app + credentials, WooCommerce plugin, network advertiser-ID sync.
- Partner MCP server with write tools (after BLK-006); per-org API keys and outbound webhooks.
- Encrypted credential storage (SEC-4).

---

## 16. Testing and verification rules
- **No test writes against production**, and no test partner org in the shared tenant. Per `exafyltd/vitana-v1` CLAUDE.md and platform NEVER rules 43–45, any test or automation account must be registered in `service_bot_accounts` and `notification_test_actors` before it exists.
- Engine, tracking and exception rules are covered by unit and integration tests with mocked Stripe, network and email providers.
- Stripe runs in test mode only, outside production.
- UI changes follow the targeted visual verification protocol (desktop 1400×900 and mobile 390×844).
