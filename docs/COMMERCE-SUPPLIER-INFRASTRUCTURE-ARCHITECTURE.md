# Vitanaland Commerce — Supplier Infrastructure, Qualification and Referral Economics (Architecture)

**VTID:** VTID-04732
**Status:** Approved by the platform owner 2026-09-29 (direction: sections 13–30 and the "Economic Opportunity & Community Income" mission). Nothing in this document is built yet; each delivery step (§12) gets its own VTID and PR. The decisions in §11 remain open until answered. Legal, tax and accounting decisions are listed in §11 and are **not** assumed in any design choice.
**Extends:** `docs/COMMERCE-SELF-SERVICE-PARTNER-ONBOARDING-SPEC.md` (VTID-04330). That spec stays the source for the onboarding engine, lifecycle, sales tracking and exception queues. This document adds the canonical Supplier ID, the configurable qualification layer, marketplace eligibility, and the commission and referral economics. Where the two disagree, this document wins for §7 (verification) and §9 (money) of the spec.
**Method:** a read-only audit of both repositories (`vitana-platform`, `vitana-v1`) on 2026-09-29, `main` @ `1d9d2108`. §2 lists what exists and whether it is reused. New infrastructure is proposed only where §2 shows a genuine gap.

---

## 1. What Commerce is

Commerce is **Vitanaland's global supplier infrastructure**, not a shop with a vendor form. It has four connected responsibilities that share canonical identities but stay separate domains:

| Domain | Question it answers | Primary records |
|---|---|---|
| **A. Supplier Registry** | Who is this supplier, and which tenants do they work with? | `partner_organizations` (+ Supplier ID), tenant relationships |
| **B. Qualification & Compliance** | Which requirements apply, what evidence exists, and is the supplier/offering eligible right now? | requirement catalogue, requirement rules, evidence, eligibility |
| **C. Offerings & Distribution** | What does the supplier offer, and where may it appear in Discover? | `products` (offerings), tenant visibility, Discover gates |
| **D. Commercial & Referral Economics** | Who caused this sale, and how is the commission split? | referrals, clicks, conversions, commission rules, commission ledger, payouts |

The end-to-end chain:

```
Supplier onboarding (AI/MCP or form)
  → Supplier ID
  → Qualification (requirements → evidence → verification → eligibility)
  → Tenant relationships
  → Integrations / capabilities
  → Offerings
  → Discover distribution (eligibility-gated, never commission-ranked)
  → Referral → click → conversion
  → Commission rule/version applied → commission ledger
  → Confirmation / reversal → member wallet → payout
```

### 1.1 North star

> Does this make it easier for a trustworthy supplier to join Vitanaland, easier for a good product or service to reach the right people, and easier for a community member to build a legitimate income stream from creating that connection?

Vitanaland should help people improve two dimensions of quality of life: **live better, earn better.** Commerce is designed so that a community member can go from *Discover → Recommend → Earn*, with the tracking, calculation and payout handled by the platform.

### 1.2 Invariants (apply to every Commerce change)

1. **One supplier, one Supplier ID.** Every business that provides a product or service through Vitanaland, in any tenant, industry, category, sales model or integration type, has exactly one canonical supplier record. Company name and email are never the identity.
2. **Two ways in, one registry.** AI/MCP onboarding and manual onboarding call the same API and write the same records. There are no "AI suppliers" and "manual suppliers".
3. **No vague approval flag.** Eligibility is derived from named requirements and evidence. The platform can always say *what* was checked, by whom or what, and until when.
4. **Evidence strength is never inflated.** A supplier declaration is shown as a declaration, never as an independently verified fact.
5. **AI prepares, rules decide, people decide the rest.** AI extracts, classifies, maps and flags. Deterministic checks run automatically. Where regulation, policy or risk requires authoritative verification or human approval, the case goes to the exception queue. Nothing is silently guessed.
6. **Commission never influences ranking or recommendations.** Discover ranking, search ranking, ORB and autopilot recommendations, and every health recommendation are computed without any commission, earnings or payout input. Commission size never overrides supplier eligibility, offering eligibility, health and safety rules, tenant policy, regulation or AI safety rules.
7. **History is never recalculated from current settings.** The commission rule version that applied to a commercial event is stored with it. Changes, refunds and reversals are new ledger entries; nothing rewrites financial history.
8. **Cross-tenant, tenant-aware.** Infrastructure is shared across MAXINA, Al-Kalma, Earthlinks and future tenants; eligibility to list or to promote is evaluated per tenant.
9. **No legal conclusions in code.** Merchant-of-record status, tax treatment, KYC thresholds and payout obligations are configuration values set after legal/accounting confirmation (§11), never hard-coded assumptions.
10. **Earning participants are not employees.** The referral model is an independent earning opportunity. Nothing in the data model or copy implies employment.

---

## 2. Reuse map (audit, `main` @ `1d9d2108`)

Legend: **Reuse** = use as is; **Extend** = add columns/behaviour; **Replace** = superseded by the target design (migrated, not deleted blind); **Gap** = nothing usable exists.

### 2.1 Supplier Registry (A)

| Existing | Where | Verdict |
|---|---|---|
| `partner_organizations` (+ members, invites, `partner_onboarding_steps`, `partner_terms_acceptances`); `partner_type`, `lifecycle_state`, `legal_name`, `vat_id`, `website`, `country`, `trust_level` | migrations `20260915120000_vtid_03932…`, `20260924130000_vtid_04471…`, `20260924150000_vtid_04478…` | **Reuse as the root supplier entity.** Already the designated root (spec §5.1). Global, not tenant-scoped, which is what a cross-tenant supplier identity needs. |
| `org_key` (slug + 6 hex, client- or name-derived, mutable) | `routes/partner-onboarding.ts:97-107`, `partner-orgs.ts` | **Keep as a URL slug only.** It is not suitable as the canonical ID: derived from a name, client-supplied on one path, no immutability guard. |
| FKs to the org: `merchants.partner_organization_id`, `partner_registry.partner_organization_id`, VCAOP `partner_tenant.partner_organization_id` | as above | **Reuse.** These already make the org the hub. All are nullable; the legacy backfill (spec §5.1) must finish before the Supplier ID is the only reference. |
| `partner_registry` (health capabilities, `partner_key`, DoctorBox = "Partner #001") | `20260914090000_vtid_03885…` | **Reuse** as the health-integration capability record hanging off the org. |
| `merchants` (catalogue owner; `slug`, `source_network`/`source_merchant_id`, `commission_rate`, `onboarding_status`, `vertical_key`) | `20260416120000_vtid_02000…`, `…vtid_03894…` | **Reuse** as the catalogue container of a supplier. `commission_rate` is **replaced** by commission rules (§8). |
| VCAOP `BusinessIdentity` (legal name, registration no., VAT/EORI, EIN), `Provider`, `PartnerTenant` | `prisma/schema.prisma:114,135,396` | **Merge into the org** over time: `BusinessIdentity` duplicates the org's company facts and has no link to it. |
| `services_catalog.provider_name`, `lab_tests.provider_name`, `community_listings.seller_user_id`, `reseller_profiles` | various | **Not suppliers.** Free-text names or community members. Out of scope for the Supplier ID; see §4.4. |
| Identifier conventions: `VTID-NNNNN` (sequence + allocator, immutable), `FB-YYYY-MM-NNNNNN` (sequence + BEFORE INSERT trigger), `profiles.vitana_id` / `registration_seq` (sequence-backed public member ID) | `20251217000000_vtid_ledger…`, `20260428200000_vtid_02047…`, `vitana-v1 20260503000000_vitana_id_v2…` | **Reuse the pattern** (dedicated Postgres sequence, zero-padded, assigned by trigger, immutable) for the Supplier ID (§3). No `VIT-`/`SUP-` scheme exists today, so there is no conflicting standard. |
| Partner↔tenant relationship | — | **Gap.** `tenant_catalog_overrides` exists but is not enforced anywhere; VCAOP `partner_tenant.tenant_id` is free text. |
| Partner MCP / API | `services/vcaop-mcp` (OAuth 2.1 AS + resource server, consumer-shopping tools, dev/staging only — BLK-006/007); `/api/v1/partner-onboarding/*` REST (user JWT) | **Extend** the MCP auth server with partner scopes and onboarding tools (§6). No partner-scoped API keys exist. |

### 2.2 Qualification & Compliance (B)

| Existing | Where | Verdict |
|---|---|---|
| Verification checks (email, domain via DNS TXT/meta, VAT via VIES; business verification and licence `not_configured`), trust levels L0–L2 | `services/partner-verification.ts`, `partner-verification-io.ts`, `routes/partner-onboarding.ts:370-515` | **Reuse the check implementations** as *verification methods*; **replace** the hard-coded level/step constants with requirement rules (§5). |
| `REQUIRED_BY_TYPE`, `VERIFICATION_LEVEL_REQUIRED`, `EU_COUNTRIES` as TypeScript constants | `services/partner-onboarding-checklist.ts:20-70` | **Replace** with data (§5.2). No jurisdiction, tenant, offering or risk dimension today. |
| Result storage in `partner_onboarding_steps.detail` JSONB; no expiry (only "stale if facts changed") | as above | **Replace** with evidence rows that carry dates and status (§5.3). |
| `decision_policy` (versioned, `effective_from/until`, tenant override over global, resolver) | `20260527000000_VTID_03113`, `services/decision-contract/policy-resolver.ts` | **Reuse its semantics** (versioning, effective dates, tenant precedence) for requirement rules and commission rules. Not reused as the storage itself: it is keyed by one `policy_key` and cannot match on several dimensions (§5.2 explains). |
| `catalog_verticals` (`is_regulated`), `catalog_vertical_fields` (data-driven field definitions, vocabularies) | `20260915100000_vtid_03894…` | **Reuse** verticals as the offering-category dimension; **reuse the pattern** of data-driven field definitions for requirement evidence fields. |
| VCAOP `Provider.required_documents`, `jurisdiction`, `tos_risk_level`, `kyb_required`; `HumanTask` (`type`, `status`, `sla`, `evidence_refs`); `human-gate.ts` | `prisma/schema.prisma:135,247`, `services/vcaop/src/guardrails` | **Reuse the shapes** (required documents, risk level, human task with evidence refs) in the new tables; the VCAOP KYB artifact is not persisted anywhere (`kyb_artifact` has no table). |
| `data_sharing_consents` + append-only `data_sharing_consent_events`; `partner_health_*` tables, consent choke point, DoctorBox adapter | `20260914090000_vtid_03885…`, `services/partner-health/*` | **Reuse unchanged** for health-data processing; data-protection requirements reference them as evidence (§5.5). |
| `partner_health_result_inbox` (reason, candidates, resolved_by, resolved_at); `requires_admin_review` flags; `listing_status_history` | as above, `admin-marketplace.ts` | **Generalize** into one exception queue (§5.6). |
| Product compliance columns: `certifications TEXT[]` (free text), ingredients, allergens, contraindications, ships-to, `excluded_from_regions` | `20260416120000_vtid_02000…:189` | **Extend**: product-level evidence links for certifications (§5.4); keep the safety columns as they are. |
| Document storage for compliance evidence | — | **Gap.** No bucket, no table. `services/storage/storage-provider.ts` (signed URLs) is reused; a private bucket is new. |
| Content scan (prohibited categories, health claims) for the commerce catalogue | — | **Gap.** Only peer-to-peer listing moderation exists (`listing-moderation-check.ts`). |

### 2.3 Offerings & Distribution (C)

| Existing | Where | Verdict |
|---|---|---|
| `products` (the only live, generic offering; merchant-owned; ships-to; safety columns; `attributes` JSONB; `is_active`, `requires_admin_review`; embedding) | `20260416180000_vtid_02000_fix_products_v2.sql` | **Reuse as the offering table.** Services and tests are already sold as `products` rows (DoctorBox). |
| `services_catalog`, `products_catalog` | `20251231100000_vtid_01092…` | Not deployed (gateway comments). **Do not build on them.** ORB `browse_wellness_services` still reads `services_catalog` — separate cleanup. |
| Discover feed/search (`is_active`, `in_stock`, origin scope, ships-to, `applyUserLimitations`, `rankFeedProducts`) | `routes/discover-feed*.ts`, `services/feed-ranker.ts`, `routes/discover-search.ts` | **Extend** with eligibility and tenant gates (§7). Today Discover ignores `merchants.onboarding_status`, `merchants.is_active` and supplier state, and is fully global. |
| `tenant_catalog_overrides` (hide / require_approval / feature) | foundation migration `:326` | **Reuse and actually enforce** (§7). |
| Ranking inputs: rating, featured, category mix, topic affinity, condition match, region, budget. **No commission input** (confirmed by grep). VAEA matcher weights tier `own > vetted_partner > affiliate_network` | `services/feed-ranker.ts`, `services/vaea/src/matcher/catalog-matcher.ts:30-80` | **Keep commission-free and lock it with a test** (§7.2). The VAEA "own product first" weight is a commercial preference — owner decision D-9. |
| Checkout: affiliate redirect for everything except `source_network IN ('manual','partner')`, which debits the Vitana wallet | `services/checkout/checkout-service.ts:48` | **Reuse.** The model supports affiliate/redirect today and a Vitanaland-managed checkout later (§8.6). |

### 2.4 Commercial & Referral Economics (D)

| Existing | Where | Verdict |
|---|---|---|
| `product_recommendations` (one per user × product, `sharing_link_id`, click/conversion counts, earned amount), share URL `?rec=<id>` | `20260715120000_vtid_02950…`, `routes/discover-recommendations.ts` | **Reuse as the referral record** (`referral_id` = its id). |
| `sharing_links` (`short_code`, UTM, `expires_at`) | `20260318000000_vtid_01250…:170` | **Reuse** for short links. |
| `GET /r/:product_id` click redirect → `product_clicks` (`click_id`, `attribution_recommendation_id`, surface, hashes); network sub-IDs (`clickref`, `subid`, …) | `routes/click-redirect.ts` | **Extend**: validate the referral server-side (§9.2). Today the referral comes only from `?rec_id=` and is not validated; the buyer's identity is read from an unverified JWT and is usually absent (plain `<a href>`). |
| `product_orders` (`state` pending/converted/refunded/cancelled/chargeback/unmatched, `amount_cents`, `commission_cents`, `click_id`, `attribution_recommendation_id`, `UNIQUE(merchant_id, external_order_id)`) | foundation migration `:527` | **Reuse as the conversion record.** `user_id NOT NULL` likely blocks attribution of anonymous buyers — fix in §9. |
| Network conversion intake: Awin pull (`awin-order-sync.ts`), Admitad postback (`vcaop-postback.ts`) | as named | **Reuse.** |
| Recommend & Earn split: member gets `commission_cents × rate`, rate = merchant override or `admin_settings.recommendation_commission_default_rate` (0.20); `recommendation_commissions` stores `rate_applied`, `vitana_commission_cents`, `payout_amount_minor`; idempotent per order | `services/recommendation-commissions/credit-recommender.ts` | **Replace** with commission rules + ledger (§8). It already persists the applied rate per event — the right instinct — but rates are not versioned, the Vitanaland share is never recorded, the credit is immediate on `converted`, there is no reversal, no self-referral check, and non-EUR/USD is silently skipped. |
| Canonical fiat wallet: `wallet_accounts` + append-only `wallet_ledger_entries` (BIGINT minor units, `UNIQUE(reference_type, reference_id, entry_type)`, `earning_credit`, `refund_debit`), RPCs `credit_wallet_for_earning` / `debit_wallet_for_spend` | `20260529000000_VTID_03200…`, `20260601000000_VTID_03249…` | **Reuse as the only member money store.** It is where payable earnings land. |
| Legacy wallets: `user_wallets` + `wallet_transactions` (DECIMAL), `wallet_balances` buckets (`cash_balance`), VCAOP `rewards_ledger` (mutable) | vitana-v1 `20250921100510…`, `20260526000000_VTID_03107…`, VCAOP migration `0002` | **Do not extend.** Four parallel money systems exist today; this design adds no fifth and migrates earnings reads to the canonical wallet (D-7). |
| VCAOP settlement ledger design (versioned `config_version`, basis points, integer minor units, idempotent instructions, compensating reversals, `reconcile()`) | `services/vcaop/src/settlement/ledger.ts` (in-memory only) | **Reuse the design** for the commission ledger (§8.4). |
| Other split rates in code: VCAOP member share 0.5 (`vcaop.ts`, `vcaop-postback.ts`, `awin-conversions.ts`), reseller 15% (vitana-v1), Connect "10% platform fee" comment (unimplemented) | as named | **Replace** by commission rules; each becomes a rule, not a constant. |
| Invite anti-abuse (own-code, test/service accounts, same tenant, account age, one per claimant, velocity cap) | `services/community-autopilot/invites.ts` | **Reuse the checks** for referral fraud rules (§9.4). |
| Stripe Connect Express (member onboarding, status, dashboard link, `account.updated` webhook) | `routes/creators.ts`, `routes/stripe-connect-webhook.ts`, `20260209_vtid_01231…` | **Reuse** for member payouts (§10). No withdrawal from `wallet_accounts`, thresholds, tax info or self-billing exist — gaps. |
| Referrer UI: `RecommendButton`, `useMyRecommendations`, Business Hub earnings (reads legacy `wallet_transactions`), `Wallet.tsx`, creator payments | `vitana-v1/src/...` | **Extend** once the ledger exists (§10.3). |

---

## 3. Domain A — Supplier Registry and the Supplier ID

### 3.1 The Supplier ID

| Property | Design |
|---|---|
| Column | `partner_organizations.supplier_id TEXT UNIQUE NOT NULL` |
| Format | `VIT-SUP-` + 8-digit zero-padded number, e.g. `VIT-SUP-00000042`. Follows the platform's only ID convention (prefix + zero-padded sequence number, as `VTID-NNNNN` and `FB-…-NNNNNN`). No competing supplier ID standard exists (§2.1). |
| Generation | Dedicated Postgres sequence `supplier_id_seq`, assigned by a `BEFORE INSERT` trigger when the value is NULL (the `feedback_ticket_seq` pattern). Never supplied by a client, never derived from a name. |
| Immutability | `BEFORE UPDATE` trigger rejects any change to `supplier_id`. Numbers are never reused, also after deletion or rejection. |
| When assigned | At creation of the organization record (D-1 recommends this). It is then the one reference used by every integration, API and MCP call during onboarding, before go-live. "Live" is a lifecycle state, not a property of the ID. |
| Backfill | Every existing org gets an ID in creation order. Legacy merchants/connections without an org get a one-member org first (spec §5.1 backfill), then an ID. |
| Where it is used | API and MCP payloads, OASIS event payloads (`supplier_id` alongside the UUID), offerings (`merchants.partner_organization_id` → org), conversions, commission ledger, evidence, tenant relationships, contracts/terms, exports and audit logs. Internal joins keep using the UUID primary key; the Supplier ID is the canonical **external** reference. |
| What it is not | Not a login, not a secret, not an authorization. Knowing a Supplier ID grants nothing. |

### 3.2 One supplier, many relationships

```
partner_organizations (supplier_id)
 ├─ partner_organization_members          people and roles
 ├─ merchants                             catalogue containers → products (offerings)
 ├─ partner_registry                      health integration capabilities (labs, DoctorBox)
 ├─ partner_tenant / integration_manifest integrations (VCAOP)
 ├─ supplier_tenant_relationships   (new) which tenants, which status, which terms
 ├─ supplier_evidence               (new) qualification evidence
 └─ commission_rules                (new) commercial terms
```

**`supplier_tenant_relationships`** *(new; the partner↔tenant gap in §2.1)*: `supplier_id`, `tenant_id`, `status` (`proposed | active | paused | ended`), `activated_at`, `ended_at`, `terms_version`, `notes`. One supplier can serve several tenants; a tenant may decline a supplier. Discover and referral eligibility read it (§7, §9).

### 3.3 Duplicate suppliers

A second registration for a business that already exists (same VAT ID, same verified domain, same registry number) does **not** create a second identity: it goes to the onboarding exception queue as "suspected duplicate" (spec §10) and is resolved by joining the existing org. Matching keys are listed in the rule configuration, not in code.

---

## 4. Suppliers, categories and capabilities

### 4.1 Supplier category

`partner_type` (`lab | supplier_shop | practitioner_clinic | service_provider | affiliate_brand`) stays the supplier category. New categories are added through the CHECK list and a requirement-rule set, not through code branches.

### 4.2 Offering category

`catalog_verticals` (`supplements, diagnostics, fitness_equipment, apparel, wine_spirits, beauty_care, devices_wearables, home_living, services, other`) is the offering-category dimension. Its `is_regulated` flag becomes an input to the risk level (§5.2). A supplier's categories are the set of verticals of its offerings, plus any declared at onboarding.

### 4.3 Capabilities

Integration capabilities (`partner_registry.capabilities`, VCAOP `PartnerCapability`) stay where they are; requirements may depend on them (for example, a data-protection requirement applies only when the capability `result_ingestion` is enabled).

### 4.4 Who is *not* a supplier

Community members selling second-hand items (`community_listings`), resellers of event tickets (`reseller_profiles`) and creators are **earning participants**, not suppliers (§9.1). They do not get a Supplier ID. A member who becomes a business onboards as a supplier like anyone else.

---

## 5. Domain B — Qualification & Compliance

### 5.1 The chain

```
Supplier (+ categories, capabilities, countries, tenants)
  → applicable requirement set (resolved by rules, §5.2)
  → evidence per requirement (§5.3)
  → verification (method, result, reviewer, dates)
  → eligibility per tenant × offering category (§5.7)
```

### 5.2 Requirement catalogue and rules

**`compliance_requirements`** *(new)* — what a requirement *is*, independent of who needs it:

| Column | Meaning |
|---|---|
| `requirement_key` | Stable key, e.g. `company_registration`, `eu_vat_registration`, `lab_accreditation_iso15189`, `medical_service_authorization`, `ce_marking`, `medical_device_class`, `food_supplement_notification`, `gmp_certificate`, `prohibited_substance_statement`, `organic_material_certificate`, `restricted_chemicals_declaration`, `child_labour_policy`, `supply_chain_declaration`, `professional_liability_insurance`, `dpa_signed`, `responsible_medical_contact` |
| `kind` | `legal_regulatory` \| `third_party_certification` \| `supplier_declaration` \| `marketplace_standard` — the four kinds the owner requires to stay distinguishable |
| `scope` | `supplier` or `offering` (e.g. a GMP certificate belongs to the supplier; a CE marking to a device offering) |
| `evidence_fields` | Data-driven field definitions (issuer, reference number, class, …), following the `catalog_vertical_fields` pattern, so the form and the MCP schema are generated, not coded |
| `accepted_methods` | Allowed verification methods, strongest first: `registry_lookup`, `issuer_api`, `document_review_human`, `document_check_automated`, `declaration` |
| `requires_human_verification` | True where regulation, policy or risk demands an authoritative human decision; AI then only prepares the case |
| `has_expiry`, `renewal_notice_days` | Expiry behaviour |
| `display` | Catalog keys for the name and the member-facing trust-fact wording (§5.8) |

**`compliance_requirement_rules`** *(new)* — who needs it:

| Column | Meaning |
|---|---|
| `requirement_key` | → catalogue |
| Matching dimensions (NULL = any) | `supplier_type`, `vertical_key`, `jurisdiction` (country or region group), `tenant_id`, `risk_level`, `capability` |
| `obligation` | `required` \| `optional` \| `not_applicable` (an explicit override that removes a broader rule) |
| `blocks` | What a missing/expired required item blocks: `supplier_live`, `offering_listing`, `referral_eligibility`, `payout` |
| `version`, `effective_from`, `effective_until`, `created_by`, `source` | Versioning and effective dates with the same semantics as `decision_policy` |

**Resolution.** For a supplier (and optionally an offering), collect every effective rule whose non-NULL dimensions all match; the most specific rule per `requirement_key` wins (more matched dimensions beats fewer; a tenant-specific rule beats a global one — the `decision_policy` precedence). The result is the requirement set, recomputed whenever facts, rules or evidence change.

**Why not store this in `decision_policy`.** `decision_policy` is keyed by a single `policy_key` with a JSON value; requirement rules must be matched on six dimensions and queried ("which suppliers are affected if this rule changes?"). A dedicated table keeps that queryable while reusing the same versioning and precedence rules and the same admin/audit conventions.

**Risk level** is derived, not typed in: from `catalog_verticals.is_regulated`, `partner_type`, capabilities (health data), jurisdiction and offering attributes. The derivation function is data-driven too (thresholds in `decision_policy`).

### 5.3 Evidence

**`supplier_evidence`** *(new)*, append-oriented:

| Column | Meaning |
|---|---|
| `id`, `supplier_id`, `offering_id` (NULL for supplier-scope), `requirement_key` | What it proves, for whom |
| `issuer`, `reference`, `jurisdiction` | e.g. "DAkkS", "D-ML-12345-01-00", "DE" |
| `document_ref` | Private storage object (new private bucket; signed URLs via `storage-provider.ts`); never public |
| `fields` | Structured values per `evidence_fields` |
| `issued_on`, `expires_on` | Dates |
| `status` | `submitted → validated → verified` or `→ rejected`; `verified → expired` (time) or `→ revoked` (issuer/registry or exception outcome); `superseded` when a newer row replaces it |
| `verification_method` | Which accepted method produced the status |
| `automated_result` | Output of automated checks (extraction, plausibility, registry response), including confidence |
| `verified_by` | `system` or the reviewer's user id when a human decided |
| `verified_at`, `rejection_reason`, `ingestion_channel` (`mcp`, `assistant`, `form`, `connector`, `registry`) | Audit |
| `supersedes_evidence_id` | Chain of renewals |

Status changes append an `supplier_evidence_events` row and emit an OASIS event; rows are never edited in place except for the status pointer.

The existing checks map in directly: email/domain → `domain_ownership` evidence (method `issuer_api`/DNS), VIES → `eu_vat_registration` (method `registry_lookup`), Stripe Connect business verification → `company_verification` (method `issuer_api`). `trust_level` stays as a derived summary for compatibility.

### 5.4 Offering-level evidence

Offering-scope requirements (a CE marking, a supplement notification, an organic-cotton certificate) attach to `products.id`. The free-text `products.certifications TEXT[]` becomes a display cache derived from verified evidence; a certification a supplier merely types stays labelled as a declaration.

### 5.5 Category examples (configuration, not code)

| Category | Typical requirement set (illustrative; the real sets come from compliance, D-4) |
|---|---|
| **Medical / health** (lab, clinic, practitioner) | company verification; applicable professional licences; laboratory accreditation; medical-service authorization where required; insurance; quality certification; DPA signed and health-data processing terms; responsible medical and legal contacts; country-specific items. **DoctorBox is the reference implementation** for `lab` × `diagnostics` × `DE`. |
| **Supplements** | manufacturer information; composition; food/supplement registration or notification; quality/GMP certificate; ingredient restrictions; lab testing evidence; prohibited-substance statement; country eligibility |
| **Devices and wearables** | manufacturer identity; product certification (e.g. CE); medical-device classification where applicable; safety certification; data/privacy terms; interoperability information; country eligibility |
| **Fashion / apparel** | Vitanaland **marketplace standards** (kind `marketplace_standard`): material requirements, organic/sustainable standards, restricted chemicals, supply-chain and labour declarations, child-labour policy, environmental requirements, origin transparency, supporting certificates |

The same supplier type can have different sets per jurisdiction and tenant; nothing assumes one medical model everywhere.

### 5.6 Exceptions

One **`commerce_exceptions`** queue *(new; generalizes `partner_health_result_inbox` and VCAOP `HumanTask`)*: `queue` (`onboarding | evidence | health_results | commerce`), `subject` (supplier, offering, evidence, order, referral), `reason` (configurable code), `evidence_refs`, `ai_summary` (what the AI extracted and why it is unsure), `allowed_resolutions`, `sla_due_at`, `status`, `resolved_by`, `resolution`, `resolved_at`. Every resolution is audited and emits OASIS. This is the spec's §10 made concrete; the health-result inbox keeps working and is migrated into it later.

What goes there: evidence the rules cannot decide (unreadable document, name mismatch, registry unavailable), every requirement with `requires_human_verification`, duplicates, conflicting information, and all commerce fraud signals (§9.4).

### 5.7 Eligibility

`supplier_eligibility` *(new, derived, one row per supplier × tenant × vertical, plus offering-level rows)*: `status` (`eligible | eligible_with_warnings | not_eligible`), `unmet_requirements[]`, `expiring_soon[]`, `evaluated_at`, `rule_versions`. Recomputed on every change and by a daily job that expires evidence (`expires_on < today`) and re-evaluates. Expired **required** evidence makes the affected scope `not_eligible` according to the rule's `blocks` list: an expired lab accreditation hides the lab's diagnostic offerings and stops new referrals for them; it does not delete anything.

Lifecycle (`partner-lifecycle.ts`) keeps owning the supplier state; `live` additionally requires `eligible` for at least one tenant. Losing eligibility moves a live supplier to `paused` (automatic, recoverable) per spec §5.2.

### 5.8 What members and suppliers see

Never "Vitanaland Approved". Trust facts rendered from evidence, each with its strength:

- "Identity verified" (company verification, `issuer_api`)
- "Required documentation provided" (all required items at least `submitted`)
- "Medical licence valid until 31 Dec 2027" (`verified`, date shown)
- "Laboratory accreditation verified" (`registry_lookup` or `document_review_human`)
- "Sustainability declaration received" (kind `supplier_declaration` — worded as received, never as verified)

---

## 6. AI-first onboarding, manual always available

### 6.1 One flow, three ways in

The spec's three ways in (assistant, partner's own agent via MCP, step-by-step form) all run the same twelve steps against the same API:

1. identify the supplier (existing org, or new) → 2. determine categories and capabilities → 3. resolve the requirement set (§5.2) → 4. request structured information and evidence → 5. ingest what the supplier's system provides → 6. validate structure and completeness → 7. validate evidence where technically possible → 8. list missing or conflicting items → 9. send only exceptions to review → 10. create/update the supplier profile → 11. Supplier ID (assigned at step 1 per D-1) → 12. proceed to activation.

### 6.2 MCP surface (partner-scoped)

Extends the `services/vcaop-mcp` OAuth 2.1 authorization server (dynamic client registration already exists) with partner scopes `partner:onboarding:read|write`, `partner:evidence:write`, `partner:catalogue:write`, `partner:commerce:read`. Tools are thin wrappers of the REST API:

| Tool | Purpose |
|---|---|
| `get_supplier_profile` | The org, Supplier ID, lifecycle, eligibility |
| `get_requirements` | The resolved requirement set with the machine-readable schema of every evidence field (generated from `evidence_fields`) and what is still missing |
| `submit_company_facts` | Company facts |
| `submit_evidence` | Structured evidence + document upload; returns validation result per item |
| `submit_offerings` | Catalogue rows (same validation as the form and the CSV import, VTID-04731) |
| `get_open_items` | Missing, conflicting, expiring and exception items |

Rules the agent cannot bypass: it never approves itself, never marks evidence verified, never signs or accepts terms without the supplier's human confirmation (VCAOP `human-gate.ts` stays), and every call is audited with `ingestion_channel='mcp'`. Public availability depends on BLK-006.

### 6.3 AI boundaries

AI may extract, classify, map fields, detect expiry dates, compare evidence against requirements, flag inconsistencies, prepare decisions and run deterministic validations. It writes `automated_result` with confidence. It never sets `verified` on a requirement with `requires_human_verification`, and any low-confidence result goes to `commerce_exceptions` with the AI summary attached. LLM calls go through `llm_routing_policy` on Bedrock (ALWAYS 10a) with the supplier's locale injected.

---

## 7. Domain C — Offerings and Discover distribution

### 7.1 Visibility gates (added to feed, search, ORB product tools, autopilot and shopping agent)

An offering is shown to a user in tenant T only if **all** hold:

1. `products.is_active` and in stock (today's rule);
2. its supplier is `live` and `eligible` for T and the offering's vertical (§5.7), and the offering itself has no unmet offering-scope requirement;
3. `supplier_tenant_relationships(supplier, T).status = 'active'` (with a migration default for existing network merchants, D-6);
4. no `tenant_catalog_overrides` `hide` for T (finally enforced);
5. ships to the user's country/region, and passes `applyUserLimitations` (today's rules).

One shared predicate implements this so the five surfaces cannot drift.

### 7.2 Ranking stays commission-free

- Ranking inputs stay as they are (rating, relevance, health fit, geography, budget, diversity caps).
- A guard test fails the build if any ranking or recommendation module (`feed-ranker.ts`, `discover-search.ts` scoring, ORB marketplace tools, recommendation-engine analyzers, shopping agent, VAEA matcher) reads a commission, earnings or payout field. This makes invariant 6 enforceable, the same way the repo's other drift guards work.
- Earning information may be **displayed** next to an offering to an eligible referrer ("you can earn €19.90 recommending this"), never used to choose or order what is shown, and never shown inside a health recommendation.
- The VAEA matcher's `own > vetted_partner > affiliate_network` tier weight is a commercial preference in a recommendation path; D-9 asks whether it stays.

### 7.3 One offering concept

`products` remains the offering table for products, services and tests. A future `offering_type` column (`product | service | test | subscription | event`) is added when a second type needs different handling; the dead `services_catalog`/`products_catalog` are not revived. Event tickets, business packages and bookings in `vitana-v1` stay where they are until checkout is unified (§8.6).

---

## 8. Domain D — Commission rules and the commission ledger

### 8.1 Unambiguous commission terms

Every amount in a rule states its **basis** explicitly. No field means "percent" without saying of what.

| Basis | Meaning | Example |
|---|---|---|
| `pct_of_gross_sale` | percentage of the sale value | referrer 10 → 10% of €100 = €10 |
| `pct_of_commission_pool` | percentage of the supplier's gross commission | referrer 20 → 20% of €15 = €3 (today's Recommend & Earn default) |
| `fixed_amount` | fixed minor units in a stated currency | €5 per signup |
| reserved: `tiered`, `recurring_pct_of_subscription_period`, `bonus` | future models, rejected by validation until implemented | — |

Percentages are stored as **basis points** (integer, 1000 = 10.00%); money as **integer minor units** plus ISO currency (the canonical wallet's convention). No floats in money math.

### 8.2 `commission_rules` *(new)*

| Column | Meaning |
|---|---|
| `id`, `version` | A rule is never edited once any event used it; a change is a new version |
| `scope` | `platform` \| `supplier` \| `offering` \| `campaign` |
| `supplier_id`, `offering_id`, `campaign_id`, `tenant_id` | Scope keys (NULL where not applicable) |
| `effective_from`, `effective_until` | Validity |
| `supplier_commission` | `{basis, value, currency?}` — the gross commission the supplier grants (e.g. `{pct_of_gross_sale, 1500}`) |
| `allocations` | `[{party:'referrer', basis, value}, {party:'vitanaland', basis, value}]` |
| `sale_value_basis` | Which sale amount the percentages apply to (`gross_incl_vat`, `net_excl_vat`, …) — D-12, legal/accounting |
| `referrer_eligible` | Whether referral earnings apply at all (replaces `merchants.recommendation_commission_eligible`) |
| `attribution_window_days`, `return_window_days` | Timing |
| `created_by`, `approved_by`, `source` | Who changed commercial terms |

**Validation** (write time): allocations sum to exactly the supplier commission when both are expressed in the same basis, and never exceed it; every basis is implemented; fixed amounts carry a currency.

**Resolution** (per commercial event): the most specific effective rule wins — campaign → offering → supplier → platform default, tenant-specific before global.

**Example (owner's):**

```
DoctorBox supplier default   supplier_commission = 15% of gross sale
                             referrer   = 10% of gross sale
                             vitanaland =  5% of gross sale
DoctorBox product X override supplier 20%, referrer 12%, vitanaland 8%
DoctorBox product Y override supplier 10%, referrer  7%, vitanaland 3%
Sale €100 on the default:    pool €15 → referrer €10, Vitanaland €5, supplier keeps €85
```

Today's platform behaviour becomes one row: `platform` scope, referrer `pct_of_commission_pool` 2000 (20%), Vitanaland the remainder — so nothing changes for existing merchants until a supplier rule exists.

### 8.3 Commercial events and the calculation snapshot

When a conversion is reported (network pull, postback, signed partner webhook, first-party checkout), the engine writes a **`commercial_events`** row *(new)*: `event_type` (`sale`, `refund`, `partial_refund`, `chargeback`, `cancellation`, `adjustment`), `product_order_id`, `supplier_id`, `offering_id`, `tenant_id`, `referral_id`, `referrer_user_id`, `sale_amount_minor`, `currency`, `reported_commission_minor` (what the network says, when it says it), `rule_id`, `rule_version`, and a **frozen calculation**: basis, inputs, pool, each allocation. The snapshot is what every later screen explains from; current settings are never consulted for past events.

If a network reports a commission different from the rule's expectation, the reported amount is authoritative for the pool (it is what is actually received) and the difference is recorded; a deviation above a threshold goes to the commerce exception queue.

### 8.4 `commission_ledger_entries` *(new, append-only)*

Built on the design already in `services/vcaop/src/settlement/ledger.ts` (versioned config, basis points, minor units, idempotent instruction ids, compensating reversals, `reconcile()`), persisted:

| Column | Meaning |
|---|---|
| `id`, `commercial_event_id`, `idempotency_key` UNIQUE | One posting per purpose per event |
| `party` | `referrer` (+ `user_id`), `vitanaland`, `supplier` (+ `supplier_id`) |
| `entry_type` | `accrual`, `confirmation`, `reversal`, `adjustment`, `payable`, `paid` |
| `amount_minor` (signed), `currency` | Money |
| `state_after` | `pending | confirmed | payable | paid | reversed` for that party's share |
| `created_at`, `created_by` | Audit |

No UPDATE or DELETE (enforced by trigger and RLS). A refund produces `reversal` entries proportional to the refunded amount; a reversal after payout produces a negative `adjustment` netted against future earnings (spec §9.3 clawback, never a card charge).

### 8.5 States

```
sale reported            → pending   (accrual)
return window passes / network confirms → confirmed
member payout-eligible (KYC/tax gates met, D-10) → payable  → credited to wallet_accounts
withdrawal executed      → paid
refund / chargeback / network decline at any point → reversed (compensating entries)
```

The member wallet (`wallet_ledger_entries`, `earning_credit`) is credited **only at `payable`**, referencing the ledger entry — fixing today's immediate, irreversible credit.

### 8.6 Transaction models

| Model | Money path | Status |
|---|---|---|
| **Affiliate/redirect** (D4, launch) | Buyer pays supplier; supplier or network pays Vitanaland the commission; Vitanaland pays referrers | Live for Awin/Admitad; direct partners need the spec's Phase 2 conversion endpoint |
| **Vitanaland-managed checkout** (future) | Buyer pays Vitanaland; Vitanaland settles the supplier minus commission | First-party wallet checkout exists for `manual/partner` items; full model requires D-7/D-8 decisions |

The ledger is identical for both; only the `supplier` party's entries differ (settlement owed vs commission receivable).

---

## 9. Referral attribution and earning participants

### 9.1 Earning participants

The financial model uses a generic **earning participant** (in code: `referrer`, the party in the ledger; in the product: *Recommend & Earn*, the existing name). Any eligible community member can be one: ordinary members, creators, coaches, practitioners, experts, community leaders, event participants, customers. Influencer is not a role in the model. Referrer eligibility is itself a requirement set (§5), e.g. account age, verified email, accepted referral terms, tenant membership; payout eligibility adds KYC/tax items (§10).

### 9.2 Deterministic attribution

The chain resolves to canonical IDs, validated server-side at each hop:

```
referrer_user_id → referral_id (product_recommendations.id) → click_id (product_clicks)
  → offering_id, supplier_id, tenant_id → product_order_id → commercial_event_id → ledger
```

Changes to today's flow:

1. **The click validates the referral.** `/r/:product_id` resolves `rec_id` server-side: it must exist, be active, belong to the clicked offering (or its supplier, per rule), and the referrer must be eligible for that offering in the tenant. An invalid referral still redirects the buyer, but the click is recorded unattributed with the reason.
2. **The referrer is stored on the click**, not only the referral id, so later changes to the referral cannot re-attribute past clicks.
3. **Buyer identity is optional.** `product_orders.user_id` becomes nullable (buyers are often anonymous on a partner site); the buyer is known by `click_id` only.
4. **Attribution window** comes from the applicable rule (`attribution_window_days`); last valid referral click inside the window wins; ties and conflicts are resolved deterministically and recorded.
5. **Share links** use `sharing_links` short codes, which carry `expires_at`; the session-storage copy in the frontend is a convenience, not the source of truth.

### 9.3 Tenant awareness

A MAXINA member can promote an offering only if the supplier has an active relationship with MAXINA, the offering is eligible there, and the rule allows referrers. The referral infrastructure itself is shared across tenants.

### 9.4 Fraud and abuse

Reusing the invite checks (`community-autopilot/invites.ts`) and the spec's §10 commerce queue:

- **self-referral**: referrer = buyer (by user id, or by payment/email/device hash where the partner reports it) → not paid, recorded;
- test and service accounts (`service_bot_accounts`, `notification_test_actors`) can never earn;
- duplicate conversions (same `external_order_id`), velocity caps, abnormal conversion rates, click-farm patterns → exception queue, commission held in `pending`;
- a referral cannot be attached to an order after the fact.

---

## 10. Payouts and the earner experience

### 10.1 Payout

Stripe Connect Express (existing member onboarding, status, dashboard link and `account.updated` webhook) is the payout rail (spec D3). New, gated by D-10/D-11:

- withdrawal from `wallet_accounts` (EUR/USD) to the member's Connect account;
- configurable minimum payout amount and schedule;
- payout eligibility as a requirement set: Connect `payouts_enabled`, identity/KYC where required, tax information where required, not in a restricted territory;
- self-billing invoices where the member is VAT-registered and the law requires them.

### 10.2 Transparency

Every earning line can be explained from its snapshot:

```
DoctorBox Advanced Blood Test
Sale value            €199.00
Supplier commission   15% of sale  (rule v3, DoctorBox default)
Your share            10% of sale  = €19.90
Vitanaland share       5% of sale  =  €9.95
Status                Pending — confirms on 29 Oct 2026 unless the order is returned
```

Reversals show why ("order refunded on …").

### 10.3 Earner views (not built now; the model supports them)

What can I promote; what could I earn per offering; pending / confirmed / payable / paid; performance per offering and per share link; recurring earnings; campaigns I qualify for; what I must complete before payout; why a commission was reversed. All derive from `commercial_events` + `commission_ledger_entries`; the frontend's earnings screens move from the legacy `wallet_transactions` to these.

### 10.4 Mission metrics

Computed from the ledger and exposed in the Command Hub: active earning members, total and **median** community earnings, repeat earners, recurring income generated, share of supplier commission distributed to the community, payout reliability (on time / failed), time to first earning, members with sustained monthly income — alongside GMV, supplier count, conversion rate and Vitanaland revenue.

---

## 11. Decisions that need the owner, legal or accounting

None of these is assumed in the design; each is a configuration value, a rule, or a pluggable provider. Q1–Q6 from the onboarding spec still stand.

| # | Decision | Owner | Why it matters |
|---|---|---|---|
| D-1 | Supplier ID assigned at org creation (recommended) or only at successful verification | Product | IDs referenced by integrations during onboarding |
| D-2 | Supplier ID format `VIT-SUP-NNNNNNNN` — confirm prefix and length (no existing standard conflicts) | Product | Printed on contracts and invoices |
| D-3 | Merchant-of-record and who holds funds, per transaction model; whether holding member balances in the wallet requires e-money / payment-institution licensing or an agent model | Legal / accounting | Determines whether member earnings may sit in `wallet_accounts` at all |
| D-4 | Requirement sets per supplier type × vertical × jurisdiction (medical licences, lab accreditations, supplement notifications, device classes); which require human verification; licence-verification sources (spec Q6) | Compliance | Content of `compliance_requirement_rules` |
| D-5 | Vitanaland marketplace standards for fashion and other categories (materials, chemicals, labour, supply chain) and their wording | Product / sustainability | Content of `marketplace_standard` requirements |
| D-6 | Default tenant relationships for existing network merchants (all current tenants, or MAXINA only) | Product | Discover visibility on migration |
| D-7 | Consolidate member money on `wallet_accounts` / `wallet_ledger_entries` and retire the three legacy wallets for earnings | Product / accounting | Four parallel money systems today |
| D-8 | VAT on Vitanaland's commission and on member earnings; self-billing; DAC7 or similar platform reporting (spec Q3) | Tax | Invoices and reporting |
| D-9 | Whether the VAEA matcher's "own product first" weight stays in a recommendation path | Product | Invariant 6 |
| D-10 | KYC thresholds, tax-information collection, sanctions/restricted territories for payouts | Legal / compliance | Payout eligibility requirement set |
| D-11 | Minimum payout, payout schedule, clawback policy | Product / accounting | Payout configuration |
| D-12 | Commission sale-value basis: gross incl. VAT or net excl. VAT; currency conversion rules | Accounting | Every calculation snapshot |
| D-13 | Attribution window and return window per supplier type; cookie/consent requirements for tracking (ePrivacy) | Legal / product | Rule defaults |
| D-14 | Whether members may promote health services and medical products in each jurisdiction, and the required disclosure (e.g. advertising rules for medical services, affiliate labelling — spec Q5) | Legal | May exclude categories from referral eligibility per country |
| D-15 | Earning-participant terms wording that makes clear the relationship is independent, not employment | Legal | Terms and UI copy |
| D-16 | Record-retention period for evidence, ledger and payout records | Legal | Storage lifecycle |

---

## 12. Delivery plan

Each step gets its own VTID and PR, with its staging suite (Part 1 rules 46–50). Order chosen so that every step is useful alone and money moves last.

| Step | Scope | Depends on |
|---|---|---|
| **1. Supplier ID** | Sequence, trigger, immutability, backfill, exposed in onboarding API, OASIS payloads and the workspace | D-1, D-2 |
| **2. Ranking guard** | Build-failing test that no ranking/recommendation module reads commission fields (§7.2) | — |
| **3. Attribution hardening** | Server-side referral validation on `/r`, referrer stored on the click, self-referral and test-account exclusion, nullable buyer on orders | — |
| **4. Hold and reverse today's credits** | Recommend & Earn credits become `pending` until the return window/network confirmation; declines and refunds reverse — closes today's immediate, irreversible credit | D-11 (defaults), D-13 |
| **5. Requirement catalogue + rules + evaluator** | Tables, resolver, migration of the existing checks into evidence rows, eligibility table, daily expiry job (read side first, shadow mode) | D-4 (initial sets) |
| **6. Evidence intake** | REST + form + private bucket + AI extraction + exception queue; DoctorBox as the reference set | 5 |
| **7. Discover eligibility gates** | Shared visibility predicate on all five surfaces; `supplier_tenant_relationships`; enforce `tenant_catalog_overrides` | 5, D-6 |
| **8. Commission rules + ledger (shadow)** | Tables, resolver, calculation snapshot; runs alongside `credit-recommender.ts` and reports differences | D-12 |
| **9. Ledger cut-over** | Wallet credit only at `payable`, from the ledger; `credit-recommender.ts` retired; VCAOP/reseller constants become rules | 8, D-7 |
| **10. Partner MCP onboarding tools** | Partner scopes and tools (§6.2) | 5, 6, BLK-006 |
| **11. Payouts** | Withdrawal, thresholds, payout eligibility set, self-billing | D-3, D-8, D-10, D-11 |
| **12. Earner views + mission metrics** | Frontend earnings from the ledger; Command Hub metrics | 9 |

Steps 2–4 fix live risks found by the audit and do not wait for any new domain.

---

## 13. Verification rules for this programme

- No test ever writes to production; staging writes to the production Supabase project, so staging suites are read-only (CLAUDE.md rules 31–32, 46–50). Money and evidence logic is proven by unit and integration tests over in-memory databases.
- Every money calculation has property tests (allocations never exceed the pool; reversals net to zero; replaying events reproduces balances — the `reconcile()` property).
- No test or automation account may ever earn, appear as a supplier, or appear to members (NEVER rules 43–45).
