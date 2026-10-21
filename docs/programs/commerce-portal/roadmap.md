# Commerce portal — status and roadmap (2026-10-20)

Analysis by Kiro session `kiro-jtadic-202610201358-fc62`, read-only, from `vitana-platform@3063c9543` and
`vitana-v1@996bfaf1d`. This is a **roadmap, not a sparred plan**: every item below becomes its own `plan(` PR,
goes through PLAN-SPAR and gets its VTID there (CLAUDE.md rules 51–55). Nothing here is approved by being written.

## 1. Where Commerce stands

**Built and on `main` (≈ 60 VTIDs, 2026-08-09 → 2026-10-20):**

| Area | What exists | Key VTIDs |
|---|---|---|
| Account model + lifecycle | `partner_organizations` root, 5 partner types, lifecycle graph, members/invites with SEC-1..3 fixed | 03932, 04337, 04463, 04471 |
| Onboarding engine (REST) | `/api/v1/partner-onboarding/*`: start, company, detect, verification check, catalogue (form + CSV), connections, terms, submit | 04478–04527, 04731, 05136 |
| Verification | Email, domain (DNS/meta), VAT (VIES) automatic; admin approval = level 1 | 04486, 04933 |
| Admin review | Command Hub `partner-review.html`: approve / request changes / reject / keep offline | 04933, 04954 |
| Partner terms | Publish, accept, re-accept; German binding; 11 languages | 04895, 04909–04911 |
| Discover | A supplier going live lists its products in the right category; ranking stays commission-free | 04769, 04783, 04734 |
| Referral economics | Server-validated referrals, referrer stored on the click, commissions held then confirmed/reversed | 04735, 04740, 04741 |
| AI-first onboarding | Website → draft ("Set up with AI"), voice setup, Vitana as guide, commerce specialist | 04838–04844, 04400 |
| Commerce MCP | `/mcp` with 9 tools, OAuth via Supabase Auth, client allowlist, reviewer sandbox, ChatGPT-only path, legal pages, plugin package | 04847–04897, 04938–04990, 05074–05142 |
| Supplier portal (vitana-v1) | One AI-first `/commerce` screen, guest landing, 2-step registration, SetupHub, sheets for products/CSV/sales/terms/team, consent screen, connector docs; 31 Vitest + 16 staging specs | 03882 → 05209 |
| Governance | Commerce UX contract (AI-led, one action per screen) as a standing rule | 05204 |

**In flight:**
- `commerce-step-owner` (gap C1): every open step names its owner (assistant / supplier / Vitanaland).
  Gateway lane VTID-05238, PR #4198, reviewed **approve**. It cannot merge because `main`'s gateway Jest is red
  (`test/vtid-05077-planner-fallback-and-thinking.test.ts:212` expects `app.js?v=20261120-vtid-05148`; `index.html`
  serves `…-vtid-05082`), which is plan `gateway-test-cachebust` (drafted, partner escalated). The frontend lane
  VTID-05237 (`SetupHub` grouped "Still needed") waits on the gateway lane.
- `desktop-spotlight-finish/commerce-shell` (vitana-v1 branch, 2 commits): Spotlight skin for the portal and `/shop`,
  182 → 0 design findings. The plan is drafted but its partner escalated, so it has **no VTID**. Its staging spec is
  still named `vtid-pending-…`.

## 2. Gaps that matter

**G1 — Only `service_provider` can actually go live.** `REQUIRED_BY_TYPE`
(`services/gateway/src/services/partner-onboarding-checklist.ts:49–55`) still requires:
- `tracking_test` for `supplier_shop` and `affiliate_brand`;
- `billing_mandate` for `supplier_shop`;
- `dpa` + `results_channel` for `lab`;
- `dpa` for `practitioner_clinic`.

No endpoint completes any of these steps. `lab` and `practitioner_clinic` also need verification level 2, which an
admin approval cannot grant (`partner-review.ts:215–217`). The B4 relaxation (VTID-04953) covered service
providers only.

**G2 — Spec Phase 1 acceptance is not met.** "draft → live with no admin call". Business verification and licence
have no provider (`partner-verification.ts:10–18`, spec Q2/Q6), so every L1 type needs a human approval.

**G3 — No sales tracking (spec Phase 2).** No conversion endpoint, per-org HMAC secret, postback, snippet,
discount-code attribution or tracking test. Direct, non-network partners cannot report a sale.

**G4 — No money layer (spec Phase 4, architecture steps 8–12).** Not built:
- `commission_rules`, `commission_ledger_entries`;
- billing mandate and monthly invoices;
- member cash-out and earner views.

Recommend & Earn still credits through `credit-recommender.ts`.

**G5 — Qualification is code, not data (architecture steps 1, 5–7).** Not built:
- Supplier ID;
- requirement catalogue, evidence rows and the private evidence bucket;
- exception queues (spec §10);
- `supplier_tenant_relationships`.

Requirements are TypeScript constants.

**G6 — Security debt.**
- SEC-4: connector and OAuth tokens are stored in plaintext (`marketplace_sources_config`, partner OAuth
  credentials).
- SEC-5: one platform-wide `INGEST_API_KEY` (`routes/catalog-ingest.ts:64`).
- A missing `ai_connection_grants` row or a failed grant lookup fails open on the Commerce path
  (`services/ai-connection-grants.ts`).
- The scanner probe log is marked temporary (`routes/commerce-mcp.ts:153`).

**G7 — Production switches off.**
- `COMMERCE_AI_SETUP_ENABLED` and `COMMERCE_MCP_CHATGPT` are set on staging only. The prod workflow pins only
  `COMMERCE_MCP_ENABLED`.
- `VITE_CHATGPT_PLUGIN_URL` is unset, so there is no "Connect with ChatGPT" button.
- Shopify app credentials are absent (one-click Shopify is dormant).
- The directory listing has owner facts open (`vitana-v1 docs/commerce-mcp-directory-listing.md`).
- The `commerce.vitanaland.com` DNS is deferred.
- Submit triage and the onboarding coach run in shadow mode.

**G8 — UX contract debt (vitana-v1).**
- `ConnectionWorkbench` asks for a FHIR base URL, client id, secret and scope.
- `CommercePortal.tsx` (808 lines) and `SetupHub.tsx` (745 lines) carry about ten sheets.
- The AI path disappears silently when the gateway flag is off.
- The legacy admin `/partner/connections` portal duplicates `/commerce`.
- `src/lib/commerce-mcp.ts` hardcodes a fallback Supabase URL and anon key.
- `commerceportal` has 94–199 stale keys in non-source locales. None are missing versus `de`, so this is cleanup
  only.
- Three stale `claude/commerce-portal-*` branches are superseded by #1109 and #1187.

**G9 — Not started.**
- Seller video studio and moderation (`docs/video-commerce-drawer-spec.md`, draft).
- Live-room commerce AP-1201..1210 (all PLANNED).
- "Sell directly on Vitanaland" (shown as "Coming soon"; D4 says affiliate/redirect only at launch).
- WooCommerce plugin, per-org API keys, outbound webhooks.

## 3. Roadmap

Ordered so that each wave is useful on its own and money moves last (architecture §12 principle).

### Wave 0 — finish what is in flight (now; no new plan)
1. `main` green: the `gateway-test-cachebust` plan (Claude Code, escalated). This unblocks every gateway merge.
2. Merge #4198 (VTID-05238) → STAGING-VERIFY → Gate 2. Then build `frontend-still-needed` (VTID-05237, seat
   `exafyltd`).
3. `commerce-shell`: re-spar to get a VTID, rename the staging spec, add the "UX acceptance" section.
4. Housekeeping (owner OK): delete the three superseded `claude/commerce-portal-*` branches.

### Wave 1 — every partner type can go live (highest value; owner decision first)
Close G1/G2 so the supply side is not limited to service providers.
- **Decision D-W1 (owner):** for the launch model (D4: affiliate/redirect only), are `tracking_test` and
  `billing_mandate` go-live gates now, or relaxed like B4 until Phase 2/4 ship? Relaxing is a one-file change
  plus suites. Keeping them makes Wave 2 the critical path.
- `affiliate_brand` already reports sales through the networks (Awin/Admitad). Its `tracking_test` can be satisfied
  by a verified network advertiser link instead of a pixel test. This is a candidate plan.
- **Level 2 path for `lab` / `practitioner_clinic`:** a DPA-signing step (`/dpa/sign`, versioned like partner terms)
  and an admin L2 approval that requires recorded licence evidence. This is the minimal slice of architecture
  step 6, with spec Q6 still open for automation.
- `results_channel` for labs: reuse the partner-health pipeline (VTID-03885) as the channel, and mark the step done
  when the org has a working results path.

### Wave 2 — sales tracking (spec Phase 2, architecture step 3 continued)
- Per-org conversion endpoint `POST /api/v1/partner-conversions/:orgId` with an HMAC secret, postback, idempotency
  and auto-confirm after the return window.
- A tracking test as a real step completion.
- Unknown or duplicate conversions go to a commerce exception list. A read-only Command Hub view is enough first.
- Acceptance as spec §15 Phase 2. It feeds the hold/confirm logic already built (VTID-04741).

### Wave 3 — qualification as data (architecture steps 1, 5, 6, 7)
- Supplier ID (D-1/D-2).
- Requirement catalogue + evaluator, in shadow next to `REQUIRED_BY_TYPE` until the two agree. Then
  `REQUIRED_BY_TYPE` becomes data.
- Evidence intake with a private bucket and AI extraction ("AI prepares, rules decide"). DoctorBox is the reference
  set.
- Unified onboarding exception queue in Command Hub (extends `partner-review.html`).
- Discover eligibility gates on all five surfaces. Coordinate with `mt-discover` (`discover-shared-predicate`,
  `supplier-relationships-db`), which already plans `supplier_tenant_relationships`. Do not plan it twice.

### Wave 4 — money (spec Phase 4, architecture steps 8–12)
Blocked on spec Q2–Q4 and architecture D-3, D-7, D-8, D-10..D-13 (legal, tax, accounting).
- Commission rules + ledger in **shadow** next to `credit-recommender.ts`, with difference reports.
- Cut-over (wallet credit only at `payable`).
- Stripe SetupIntent mandate + monthly invoice.
- Connect Express cash-out.
- Earner views.
- No fifth wallet (backend rule 8).

### Wave 5 — security and connectors (can run in parallel with Waves 2–3)
- SEC-4: encrypted credential storage.
- SEC-5: per-org ingest keys.
- Grants fail closed on the Commerce path once every live client has a grant row.
- Retire the scanner probe log.
- Shopify app credentials + listing (switch on one-click).
- WooCommerce plugin and per-org API keys/webhooks later.

### Wave 6 — production switch-on and UX quality (each a small plan; owner switches at Gate 2)
- Production: `COMMERCE_AI_SETUP_ENABLED`, then `COMMERCE_MCP_CHATGPT` + `VITE_CHATGPT_PLUGIN_URL` once
  OpenAI/Claude directory approvals land. Fill the listing's owner facts. `commerce.vitanaland.com` DNS.
- Promote triage and coach from shadow after reviewing their shadow logs.
- UX contract:
  - hide the FHIR fields behind one URL + OAuth (as VTID-04796 did for shops);
  - an honest note when the AI path is unavailable;
  - split `CommercePortal`/`SetupHub` into routed steps without adding friction;
  - retire `/partner/connections`;
  - remove the hardcoded Supabase fallback;
  - prune stale i18n keys.

### Later (after supply works end to end)
Video seller studio + moderation, live-room commerce automations, direct selling (needs D4 revisited, payments and
the merchant of record).

## 4. Decisions only the owner can take
| # | Decision | Unblocks |
|---|---|---|
| D-W1 | Go-live gates for `supplier_shop` / `affiliate_brand` before tracking/billing exist | Wave 1 |
| D-W2 | Accept a network advertiser link as `affiliate_brand`'s tracking proof | Wave 1 |
| D-W3 | Admin L2 approval with licence evidence until a licence provider exists (Q6) | Wave 1 |
| Q2–Q4, D-x | Verification provider, tax/terms/commission, payout rules | Waves 3–4 |
| — | Production switch-on dates for AI setup and the ChatGPT path; directory submission | Wave 6 |

## 5. Suggested next step
Wave 0 items 1–2 (Claude Code / Project Manager), and the owner's answer to D-W1–D-W3. Then a Kiro planner drafts
Wave 1 as `plan(commerce-go-live-all-types)`.
