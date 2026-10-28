# Plan v3 — Vitanaland Health Agentic System: bookable services marketplace × agent channels (Vitana, Autopilot, the Vitanaland and Maxina connectors) × native apps

**VTID-05154** · Status: **approved plan** (sparred, converged; owner approval 2026-10-13). Build phases get their own VTIDs and sparring. v1 converged 2026-10-05 (3 rounds); v2 (connector dimension) converged 2026-10-06 (2 rounds) and was approved by the owner on 2026-10-13 together with decisions D-S1…D-S8. v3 = v2 + those owner decisions + re-verification against `main` @ cf8f3a703 (platform) / v1 main of 2026-10-13, where the Maxina Community MCP (VTID-05133), the Commerce MCP's ChatGPT path and the Health Hub program (VTID-05020) have landed since v2.
**Change class:** standard. **Deliverable of the VTID this plan asks for:** the plan document
`docs/plans/VITANALAND-HEALTH-AGENTIC-SYSTEM-PLAN.md` (docs only). Each build phase in §9 gets its own
VTID and its own sparring before code.
**Scope (system areas the phases will touch):** `vitana-platform` — `supabase/migrations`,
`services/gateway/src/routes/partner-*.ts`, `services/partner-*`, `services/commerce-mcp.ts`,
`services/discover-*.ts`, `services/checkout/`, `orb/live/tools/`, `routes/commerce-mcp.ts`, `routes/community-mcp.ts`, `services/community-mcp.ts`, `services/ai-connection-grants.ts`; `vitana-v1` —
`src/pages/CommercePortal.tsx`, `src/components/commerce/*`, `src/pages/discover/*`,
`src/components/payment/BookingPaymentFlow.tsx`, `supabase/functions/stripe-*`, native shell.

<!-- plan:begin -->

## 0. Goal and the one architectural idea of v2

**One capability layer, many front doors.** Every business and member capability (list a
service, find services, get slots, book, cancel, review, read my bookings) is implemented **once**
as a gateway service with a typed contract, and is then exposed through four front doors:

1. the **app UI** (web + native shell),
2. **Vitana** (ORB voice/text tools),
3. **Autopilot** (proposals the member approves),
4. **external AI assistants via MCP**, as two connectors (owner decision D-S7, 2026-10-13):
   - **Vitanaland** — for **businesses**. Businesses belong to Vitanaland (partner orgs are global,
     not tenant-scoped: `20260915120000_vtid_03932…:31-51`). This is the existing Commerce MCP.
   - **Maxina** — for **members**. Members belong to a tenant (Maxina today; the same surface serves
     any tenant, bound by the member's own `active_tenant_id`). This is the existing Community MCP
     (VTID-05133, `routes/community-mcp.ts`, off in production).

Both already run on Claude and ChatGPT with Supabase OAuth 2.1, the client allowlist
(`mcp-client-allowlist.ts`) and the delegation guard that keeps AI-client tokens on `/mcp/*`
(`services/delegation-guard.ts`). The Commerce MCP's tools call the same
`partner-onboarding-service.ts` the portal uses and it is live in production. v3 makes "one
implementation, every front door" the rule for everything new.


Businesses (clinics, labs, physios, trainers, longevity studios, home-care facilities, wellness
brands) onboard themselves on the Commerce Portal, list **products and bookable services**, and
appear on the member-facing **Discover** marketplace. Members find, compare, book and (later) pay,
on web and in the **native mobile apps**. Vitana (voice + Autopilot) can recommend and book on
the member's behalf. **Market entry (owner decision 2026-10-13): Germany, Austria, Switzerland
first.** Spain, UAE and KSA are later markets and out of this plan's phases; the Touch Connect
lessons on licensed facilities, catalogue shape and data residency stay as design input.

## 1. Reference: what Touch Connect (touchconnect.ae) actually is — and what we take from it

Verified 2026-10-05 from its public site, terms and its unauthenticated public API
(`api.touchconnect.ae/api/v1`, read-only GETs only):

| Aspect | Finding | Lesson for Vitana |
|---|---|---|
| Model | Dubai home-healthcare **catalogue shop**: doctor at home (AED 200→170), nurse AED 29/h, ~60 IV-drip SKUs (AED 500–1,500), at-home labs, physio, radiology, peptides/HRT. Fixed 15% "discount" on everything. Transport fee per emirate (Dubai 200) | Copy the catalogue shape (fixed-price SKUs + add-ons + area fee). Do **not** copy peptides/HRT/"skin whitening" — regulatory red flag |
| Legal posture | Terms: "intermediary platform, does not provide medical services". No facility licence number shown. DHA Home Healthcare Standard (ST-57, 2025) §5.3: home care only by **licensed facilities** | In UAE every at-home medical booking must be fulfilled by a **DHA/DOH-licensed facility with home-care permission**; Vitana is the platform, the facility is the provider of record |
| Supply side | ~19 doctors in a hard-coded list; **no partner/provider onboarding page, no provider app** | Our differentiator: real self-service B2B onboarding, which we already have (Commerce Portal) |
| Apps | Store links return 404; no live app found | The "#1 app" is marketing; a working native app is a real edge |
| Channels | Web cart, WhatsApp, phone, AI chat "Sana"; Firebase Auth + UAE PASS; Tabby/Tamara BNPL; cash on delivery | UAE PASS login, BNPL, WhatsApp updates matter only for a later Gulf market |
| Tech | Next.js + nginx VM, Node/Mongo REST API, S3 me-central-1, Firebase, GA4, OpenAI | Their public API leaks doctors' emails + DOB — our provider endpoints must never expose staff PII |
| Data law | Federal Law 2/2019 Art. 13: health data stays in UAE (exceptions incl. wearables) | Matches this plan's `data_region` column (§4); the Gulf data plane itself awaits re-confirmation (§11) |

Competitors that *are* licensed (DarDoc: DHA home-care + clinic + pharmacy licences; Manzil:
JCI-accredited) confirm the pattern: licensed facility underneath, technology on top.

## 1b. What the connectors change (and what they do not)

| Area | Effect of the Connector | Plan consequence |
|---|---|---|
| **Business onboarding (Vitanaland connector)** | Already live: a supplier can register, add offerings, run verification checks, connect a store and submit from inside Claude or ChatGPT (9 tools, `services/commerce-mcp.ts:115-267`, explicit `readOnlyHint`/`destructiveHint`/`idempotentHint`/`openWorldHint`; `add_product` already accepts `kind: product\|service`, `:182`) | New service capabilities (`add_service`, `set_availability`, `list_bookings`, `confirm_booking`, `decline_booking`, `mark_completed`) ship as **MCP tools in the same PR** as their portal UI — the portal is no longer the only path, so a large part of the provider-side UI can be thinner (forms + inbox), especially on mobile |
| **Member discovery & booking (Maxina connector)** | A member can ask Claude "find me a physio near Munich who does home visits next week" | The Maxina connector (Community MCP, today 4 read-only tools: `get_my_maxina_profile`, `get_my_matches`, `find_people`, `find_activities`) gains a **`services` grant category** with `find_services`, `get_service`, `get_slots`, `hold_slot`, `book_service`, `my_bookings`, `cancel_booking`. Same endpoint and listing as the existing Maxina connector; the Vitanaland (business) connector never gets member tools |
| **Who confirms a booking** | An MCP client's tool approval is the client's UX, not ours; we cannot rely on it as the member's consent | **Two-step booking contract**: `hold_slot` (10-min hold, no commitment) → `book_service(confirmed=true, hold_id)` only after the assistant shows the member the summary (same pattern as `submit_for_verification(confirmed=true)`). Bookings with a cancellation fee, an at-home address or any health-data sharing additionally need a **member confirmation in Vitanaland** before they become `requested`: a push to the native app, or for members without the app an email with a one-time signed link to the confirm page on vitanaland.com (expires with the hold, single use) |
| **Health records to a member's AI (owner decision D-S6: in scope)** | When a member connects Claude/ChatGPT, data leaves our Bedrock-EU boundary and goes to the member's chosen assistant | Delivered as **track H** (§7c) inside the Health Hub program's rules (VTID-05020): it is the Community MCP "Phase 2 `get_my_vitana_context`" already foreseen in `docs/validation/VTID-05133/plan-sparring.md:84-86`, and it gets its **own sparred work-package plan** before code, gated on the Health Hub DPIA (Phase 0L) and per-category Art. 9 consent (D10). Rule 10a (Vitana's own LLM calls go to Bedrock) is unaffected: the member's assistant is the member's own processor choice, which counsel must confirm in the DPIA |
| **Scopes and grants** | OAuth scopes are `email profile` only. Since VTID-05133 the gateway enforces per-category grants in `ai_connection_grants` (user × client, categories `profile/matches/people/activities/commerce`, revocable in Settings → Connected AI; `services/ai-connection-grants.ts:69-82`) | **Reuse `ai_connection_grants`** — no new grant table. Add categories `services` (S2) and `health_*` (track H, per health category) by migrating its CHECK constraint (`20261013150000_vtid_05133…:46-58`) — widening only (old values stay valid), migration applied and recorded **before** any gateway code that writes the new values is deployed; the consent screen (`CommunityConsent.tsx`) and `ConnectedAiSection.tsx` gain the new toggles. Business tools keep org-role checks |
| **Prompt injection** | Supplier- and member-written text flows into third-party models | Already solved for both connectors: `cleanText` + the `supplier_data` / `member_data` envelopes (`services/commerce-mcp-safety.ts:19-39`, `community-mcp.ts:48`). New service/review fields use the same helpers; Vitana's ORB tools adopt them too |
| **Commissions & affiliate rules** | Bookings made through Claude are recorded by Vitana (`source='mcp'`, client id) → same evidence chain. Affiliate product links returned to Claude must still be **opened by the member**, never fetched/followed by the assistant | Tools return affiliate links as plain links with an instruction "present to the member; do not fetch"; the `/r/:product_id` redirect ignores non-browser user agents for commission purposes (no commission on automated fetches) |
| **Ranking neutrality** | Assistants compare offers literally | Architecture invariant "commission never affects ranking" is enforced in the shared search service, so app, Vitana and MCP rank identically |
| **Native apps** | The connector does **not** replace the apps: push notifications, in-app booking confirmation, field-staff operations, camera credential upload and payments still need them | Native plan (§8) unchanged in scope; the app becomes the **trust anchor** that confirms what external assistants request |
| **Health/commerce boundary** | Health Hub invariant (VTID-05025, CI test `vtid-05025-commerce-health-boundary.test.ts`): device-derived health data and the Vitana Index never rank or personalise commerce | `find_services`/Discover service search are commerce modules: added to the boundary scan; ranking uses only listing data, location, availability and member-stated filters |

**State of the connectors on `main` (2026-10-13):** two hand-written registries
(`COMMERCE_MCP_TOOLS`, `COMMUNITY_MCP_TOOLS`) and no shared core — the shared
`services/mcp/mcp-http-core.ts` foreseen by VTID-05133's plan was never built; Community imports
helpers from Commerce, and both share one in-memory 120 calls/min/user budget
(`commerce-mcp.ts:285-296`). This plan builds that shared core (§7b) and moves both registries onto
it without changing any tool name, schema or behaviour.

## 2. What already exists (verified in code on `main`, 2026-10-13)

| Area | Exists | File evidence |
|---|---|---|
| Supplier orgs | `partner_organizations` (+members, invites, lifecycle_state, trust_level), roles `org_admin/staff/professional` | `20260915120000_vtid_03932…`, `20260924130000_vtid_04471…`, `routes/partner-orgs.ts` |
| Onboarding | Self-service register (2-step), checklist engine, terms, submit, CSV import, AI setup (website → draft → one-tap apply), voice setup tool, Vitana commerce guide, Commerce MCP (9 tools, `services/commerce-mcp.ts:115-267`); supplier review = admin approval sets verification level 1, labs and practitioner clinics need level 2 (`services/partner-review.ts:1-19`); service providers no longer need `tracking_test`/`billing_mandate` (VTID-04953 B4) | `routes/partner-onboarding*.ts`, `services/gateway/src/services/partner-setup.ts`, `routes/commerce-ai-setup.ts`, `routes/commerce-mcp.ts`, `orb/live/tools/commerce-setup-tool.ts` |
| Go-live → Discover | Products list on Discover when org `lifecycle_state='live'`; Discover categories as data | `20261001120000_vtid_04769…`, `20261001140000_vtid_04783…` |
| Offering table | `products` is the single offering table (architecture §7.3); `services` vertical with `service_format` (in_person/online/hybrid), `duration_minutes`, `sessions_included`, `languages` | `COMMERCE-SUPPLIER-INFRASTRUCTURE-ARCHITECTURE.md:335`, verticals seed migration |
| Checkout | Affiliate redirect (`/r/:product_id`) or wallet debit for first-party; **D4: Vitana does not take payment** | `services/checkout/checkout-service.ts`, spec D4 |
| Attribution | Click hardening + commission hold/reverse | VTID-04735/04740/04741 |
| Member booking (v1) | Mock booking in `DoctorsCoaches.tsx` writes `provider_appointments` (`:108-140`; free-text `provider_id`, user-only RLS); `BookingPaymentFlow` is only the payment dialog (receives a pre-set schedule, `:30-51`) and opens `stripe-create-booking-checkout` in a popup | `vitana-v1/src/components/payment/BookingPaymentFlow.tsx`, `supabase/migrations/20251009153331_*` |
| Discover services/providers | **Mock arrays** | `DoctorsCoaches.tsx:132`, `ProviderProfile.tsx:31`, `WellnessServices.tsx` |
| Professional/staff pages | Placeholders | `src/pages/professional/*`, `src/pages/staff/*` |
| Vitanaland connector (Commerce MCP) | Live in production; `/mcp` (Claude) and `/mcp/chatgpt` (ChatGPT, staging); ChatGPT plugin package | `routes/commerce-mcp.ts`, `integrations/chatgpt-plugin/vitanaland/` |
| Maxina connector (Community MCP) | 4 read-only tools, no health data, `/mcp/community` + `/mcp/community/chatgpt`, tenant bound from the member's token, fails closed, off in production | `routes/community-mcp.ts`, `services/community-mcp.ts` (VTID-05133) |
| AI grants | `ai_connection_grants` + Settings → Connected AI (per-category toggles, disconnect) | `20261013150000_vtid_05133…`, v1 `src/components/ai-connect/*` |
| Health Hub | Wellness-only purpose, Bedrock-EU AI, consent by purpose × category (D10 not yet built), commerce–health CI boundary, DPIA gate | `docs/programs/health-hub/HEALTH-HUB-PLAN.md` (VTID-05020) |
| Partner terms | Published, shown and accepted in-app (German binding, 11 locales) | VTID-04895/04909/04911 |
| Calendar | Google calendar sync switched on in production (VTID-04914); usable for practitioner busy-sync | `services/calendar-google-sync.ts` |
| Mobile | Appilix WebView; portal mobile-adapted but connections hidden on phones (`CommercePortal.tsx:607 hidden lg:block`); AASA names `com.exafy.maxina`, assetlinks names `com.vitanaland.app`; owner decision: own native shell replaces Appilix | `src/lib/appilix.ts`, `public/.well-known/*` |

**Gaps this plan closes:** no service data (duration-based pricing, at-home, service area,
capacity, cancellation), no availability/scheduling, no supplier-linked bookings or booking
inbox, no provider operations/dispatch, no verified-booking reviews, no credential evidence for
health providers, Discover services are mock, no DACH requirement sets, no
org-level payouts.

## 3. Strategic position (one paragraph per decision)

**3.1 Vitana is the platform, never the provider.** Every service listing has a provider of
record = the supplier org (a licensed facility where the law requires one). In UAE/KSA, medical
at-home services can only be listed by an org whose evidence includes a facility licence with
home-care permission (§5). Vitana holds no healthcare facility licence (owner decision D-S3, 2026-10-13: platform routing to licensed facilities).

**3.2 Money: stay inside D4 at launch, and make bookings the evidence engine.** Affiliate click
evidence is weak (cookies, last-click). A **booking that Vitana itself records**, that the
provider confirms and later marks completed, is the strongest commission evidence possible —
stronger than any affiliate network. So services launch as **"book on Vitana, pay the
provider"**: Vitana owns the booking record; payment happens at the provider (on site, or via
the provider's own payment link). Vitana's commission is invoiced monthly per completed booking
under the existing `billing_mandate` onboarding step. This keeps D4 (Vitana takes no payment)
and owner decision 1 (affiliate-style, provable commissions).
**Owner decisions 2026-10-13:** D-S1 = members **pay the provider directly**; D-S2 = **commission per completed booking** (percentage). Because VTID-04953 (B4) removed `billing_mandate` from the service-provider go-live checklist, a new **`commission_agreement`** step is required before an org can *receive bookings* (not before listing): accept the commission terms + invoicing details; bookings stay disabled until done. It has a writer from day one: `POST /api/v1/partner-onboarding/:orgId/commission-agreement` (org_admin only, records terms version + invoicing details, idempotent). There is deliberately no connector tool for it: like the partner terms, acceptance happens on Vitanaland itself, and `get_onboarding_status` returns the link as its `next_action`.

**Later option (not in this plan's phases unless the owner reopens D-S1):** Stripe Connect **direct charges** (provider is
merchant of record, Vitana takes an `application_fee`) — guaranteed commission at payment time.
Needs architecture decision D-3 closed. UAE: Stripe Connect is "limited" (custom accounts need
Stripe contact); KSA: Stripe unavailable → Tap Payments marketplace split ("destinations").

**3.3 Products stay affiliate.** Physical products keep the affiliate/evidence chain from the
existing attribution work (VTID-04735/04740/04741: referrer on the click, commission hold/confirm/reverse). This plan only adds services.

**3.4 Agent-first, app-anchored.** Every new capability ships with its MCP tool (generated from its contract) and its ORB adapter in the same phase (§7b). The native app is where members confirm sensitive actions and where providers get time-critical alerts.

**3.5 One offering table.** Services extend `products` via `offering_type` (already planned in
architecture §7.3) plus a 1:1 detail table. No revival of `services_catalog`.

## 4. Data model (additive migrations, RLS on every table, snake_case, documented in DATABASE_SCHEMA.md)

**Where it lives:** every new table is a migration in `vitana-platform/supabase/migrations/`, next to
`partner_organizations` and `products`, served only through gateway routes. That is the production
Supabase project today; the Aurora cutover is handled by the existing migration programme, not by this
plan (platform CLAUDE.md §3: do not assume Aurora is primary). `vitana-v1`'s `provider_appointments`
is frozen (no new writers; comment pointing to `service_bookings`) — today it is only written by the
mock booking code in `DoctorsCoaches.tsx:108-140` for the **mock** providers (also shown by `ProviderProfile.tsx`), so no
real provider data has to be migrated; it stays as a read-only archive for members' past rows.
The four v1 edge functions that touch it (`stripe-create-booking-checkout`, `stripe-webhook`'s
`provider_appointment` branch, `send-appointment-email`, `send-appointment-reminder`) keep serving
existing rows only; `stripe-create-booking-checkout` is disabled for new bookings in S1 when the
mock Discover providers it serves are removed.

**Ownership key:** `products` is keyed by `merchant_id`, and `merchants.partner_organization_id`
is nullable (`20260924130000_vtid_04471…:161`) because network/affiliate merchants have no org. So:
`offering_service_details` carries its own **`org_id NOT NULL`** FK to `partner_organizations`, and
a trigger rejects a row whose product's merchant has a different (or null) `partner_organization_id`.
Services therefore always belong to a self-service org; network merchants can never own a
bookable service. All booking-side tables key on that `org_id`.

**Region:** `data_region` is a column only on the **new** tables (`service_bookings`,
`partner_locations`), with a CHECK constraint `= 'eu'` for the whole DACH launch; `products` is not
changed for region. A future Gulf data plane
(proposed as a separate stack in `me-central-1`; needs owner re-confirmation, §11)
would be its own plan; nothing in this plan writes non-EU data.

```
products                      + offering_type ('product'|'service'|'test'|'subscription'|'event'), default 'product'
offering_service_details      product_id PK/FK, duration_minutes, buffer_minutes, delivery_modes text[]
                              ('at_location'|'at_home'|'online'), location_ids uuid[], service_area_id,
                              capacity_per_slot, booking_lead_minutes, booking_horizon_days,
                              cancellation_policy jsonb (free_until_hours, fee_minor), prep_instructions_key,
                              requires_credential text[] (e.g. 'dha_home_care_facility','de_physio_licence'),
                              requires_prescription bool, pricing jsonb (base_minor, per_hour_minor, add_ons[])
partner_locations             id, org_id, name, address, geo (lat/lng), timezone, opening_hours jsonb, data_region
partner_service_areas         id, org_id, kind ('radius'|'postcodes'|'polygon'), radius_km, postcodes[], polygon,
                              travel_fee_minor
partner_practitioners         id, org_id, member_user_id (nullable), display_name, profession, languages[],
                              gender (optional, member filter), credential_ids[], public_profile jsonb
                              — public projection has NO email/phone/DOB (Touch leak lesson)
availability_rules            id, org_id, practitioner_id?, location_id?, weekday, start_local, end_local, valid_from/to
availability_exceptions       id, org_id, practitioner_id?, starts_at, ends_at, kind ('closed'|'extra')
external_calendar_links       practitioner_id, provider ('google'|'microsoft'|'ics'), busy-sync only (read)
service_bookings              id, member_user_id, org_id, product_id, practitioner_id?, location_id?, mode,
                              address_ciphertext (at_home only; see Security below), starts_at, ends_at, status, price_snapshot jsonb,
                              currency, payment_mode ('pay_at_provider'|'connect_direct'|'wallet'),
                              source ('discover'|'orb_voice'|'autopilot'|'mcp'), mcp_client_id, idempotency_key UNIQUE,
                              hold_expires_at timestamptz (only for status 'held'),
                              data_region
service_booking_events        append-only: requested, confirmed, declined, rescheduled, cancelled_by_member,
                              cancelled_by_provider, en_route, arrived, completed, no_show, disputed
service_reviews               booking_id UNIQUE (verified-booking only), rating, text, moderation_state
supplier_evidence             (from architecture doc step list) credential docs: type, issuer, number,
                              expires_at, verification_state, file in private bucket
compliance_requirements       per (country, partner_type, offering category) requirement sets
commission_ledger_entries     (architecture doc) one entry per completed booking → monthly invoice
```

**Security and isolation (S1 design, binding for all phases):**
- *At-home address*: application-level AES-256-GCM following the pattern of the existing helper
  `services/gateway/src/lib/ai-credential-crypto.ts` (pattern only — the booking key, the
  role/time-window decrypt check and the purge job are **new code scoped in S1**), key from AWS Secrets Manager/KMS (not in the DB).
  Decrypted only server-side in the booking-detail endpoint, only for: the member, the assigned
  practitioner, and the org's `org_admin`/`staff`, only while the booking is `confirmed`…`completed`+7
  days. After that the ciphertext is purged; the booking keeps postcode only.
- *RLS* (a booking spans the member and the provider org):
  ```sql
  -- service_bookings SELECT
  USING ( member_user_id = auth.uid()
          OR public.partner_org_member_has_role(org_id, ARRAY['org_admin','staff'])
          OR practitioner_id IN (SELECT id FROM partner_practitioners
                                 WHERE member_user_id = auth.uid()) )
  ```
  `partner_org_member_has_role` is a new SECURITY DEFINER helper modelled on the existing
  `public.is_partner_org_member` (`20260923120000_vtid_04337…:23`, no recursion), adding a role filter.
  So the role rule is enforced in RLS itself, not only in routes: a `professional` member reading
  Supabase directly still sees only bookings assigned to them. Writes go only through gateway routes
  using the service role. Members never see other members' bookings; orgs never see another org's.
  The public Discover projection of `partner_practitioners` is a view without email/phone/DOB.

Booking state machine (`service_booking_events` is the source of truth; `service_bookings.status` is a
projection): `requested → confirmed → (en_route → arrived →) completed`, side exits
`declined | cancelled_* | no_show | disputed`. Auto-decline after N hours unconfirmed.
`provider_appointments` (v1) is frozen, then migrated into `service_bookings` once Discover
providers are real (it only holds mock-provider rows today).

Slot computation is server-side (gateway): rules − exceptions − existing bookings − external
busy blocks − buffers, in the location/practitioner timezone. Concurrency: an exclusion constraint on
(`practitioner_id`, `tstzrange(starts_at, ends_at)`) for active statuses prevents double booking.
**Holds are bookings:** `hold_slot` inserts a `service_bookings` row with `status='held'` and
`hold_expires_at = now()+10 min`; `held`, `pending_member_confirmation`, `requested`, `confirmed`,
`en_route`, `arrived` are the *active* statuses covered by the constraint, so a hold blocks the slot
exactly like a booking. `book_service(confirmed=true, hold_id)` moves the same row `held →
requested` (or `→ pending_member_confirmation` under D-S8) in one statement guarded by
`status='held' AND hold_expires_at > now()`. Expiry: the slot engine treats `held` rows with
`hold_expires_at <= now()` as free, and the insert path first flips any expired hold on the same
practitioner/range to `expired` inside the same transaction, so an expired hold can never block a
new booking even if the sweeper is late; a sweeper job marks the rest `expired` every minute. A
member may hold at most 2 slots at once (checked in the same transaction). For services without a
practitioner (`capacity_per_slot` > 1) the constraint is replaced by a counted check under
`SELECT … FOR UPDATE` on the `offering_service_details` row.
It needs the `btree_gist` extension: available on the production project but **not installed**
(checked 2026-10-06), so the S1 migration runs `CREATE EXTENSION IF NOT EXISTS btree_gist` (also
supported on Aurora PostgreSQL).

## 5. Onboarding for service providers (extends what exists)

1. **Register** (existing 2-step wizard) → new partner types used: `practitioner_clinic`,
   `service_provider`, `lab` (already in D7).
2. **AI setup** (existing): extend the website draft to propose *services* (name, duration,
   price, mode) and *locations* from the provider's site; review card unchanged.
3. **Requirement set by country × type × category** (`compliance_requirements`):
   - **Germany:** Handelsregister/Gewerbe + USt-ID (existing VIES check); regulated health
     professions need their licence (Approbation for physicians, Heilpraktiker-Erlaubnis,
     Berufserlaubnis for physiotherapists/nurses); professional liability insurance. IV/infusion
     therapy requires a physician — category blocked unless a physician credential is attached.
   - **Austria:** Firmenbuch/Gewerbe + UID (VIES); physicians: Ärzteliste of the Ärztekammer;
     physiotherapists, nurses and other health professions: Gesundheitsberuferegister entry;
     professional liability insurance.
   - **Switzerland (not EU):** UID from the Swiss business register (not VIES — a separate
     check against the federal UID register) and MWST number where VAT-registered; physicians
     and other university medical professions: MedReg entry, health professions (physio,
     nursing, …): GesReg/NAREG entry and the **cantonal** practice licence (Berufsausübungs-
     bewilligung) for independent practice; professional liability insurance.
   - **All three:** non-medical wellness (massage, training, coaching) needs business
     registration only; categories in D-S5 are never listable; licence numbers are checked
     against the public registers where an API or download exists, otherwise verified in the
     existing supplier review (VTID-04933: labs and practitioner clinics need verification
     level 2). Spain, UAE and KSA requirement sets are written when those markets are planned.
   Evidence goes to `supplier_evidence` (private bucket, expiry tracking, reminder 30/7 days,
   listing auto-hidden on expiry). Verification is a rule check + manual exception queue — no
   admin "approved" flag (architecture invariant).
4. **Set up services**: `add_service` (portal, MCP and voice all use it) is **one gateway
   transaction** writing the `products` row (`offering_type='service'`, hidden draft as today) and
   its `offering_service_details` row together; any failure rolls both back. It takes the same
   `Idempotency-Key` handling as `createOrgProduct()` (`services/partner-setup.ts:391`), so an MCP
   retry returns the first result. Locations and availability are separate, idempotent calls; a
   service without availability simply shows "request a time". `add_product` for non-service
   types is unchanged. New "Service" path in `AddProductSheet` with duration, modes, locations,
   service area, practitioners, cancellation policy, add-ons.
5. **Availability**: weekly hours per practitioner/location; optional busy-sync from Google /
   Microsoft calendar (existing connected-apps OAuth; read-only free/busy scope); ICS for others.
5b. **Location search without new infra (S0–S2)**: postcode / city service areas and an org-entered address; no geocoding dependency.
6. **Go live** (existing lifecycle): service listings appear in Discover when org is `live` and
   every listing's required evidence is valid.
7. **MCP + voice**: extend the Commerce MCP with `add_service`, `set_availability`,
   `list_bookings`, `confirm_booking`, `decline_booking` (same OAuth, same rate limits; writes stay
   inside the org's scope); Vitana commerce guide learns the service checklist.

## 6. Member experience (Discover)

- Replace mock `DoctorsCoaches`, `ProviderProfile`, `WellnessServices` with real data from
  `/api/v1/discover/*` (`offering_type='service'`); a "Services" Discover surface (foreseen, not yet built: the 04783 migration maps the `services`
  vertical to no category and defers practitioners/services to "their own Discover surface in step C",
  `20261001140000_vtid_04783…:112-114`; S1 adds the category + subcategories).
- **DACH specifics:** prices in EUR (DE/AT) and **CHF** (CH) — `price_snapshot` stores currency and
  minor units, never converts; German copy is DE-first as today, with Swiss orthography (no ß)
  for content shown to `de-CH` members; French is already a shipped locale for Romandie;
  commission statements to Swiss businesses follow the tax decision D-8 of the commerce
  architecture (cross-border VAT) before the first CH invoice.
- Service detail: provider, practitioner(s), modes, price incl. add-ons and travel fee, next
  available slots, cancellation policy, verified reviews, map.
- Search: by category, city/postcode, mode (at home / at location / online), language, date, price.
  Map view, "near me" radius and travel-time slotting arrive in S3 with **Amazon Location Service**
  (AWS; Google Maps would need a GCP billing account — GCP is decommissioned). That is a **new AWS
  service dependency** and gets its own infrastructure VTID (IAM policy, eu-central-1, staging/prod
  split, cost cap) before S3 code.
- A new slot picker replaces the mock booking in `DoctorsCoaches.tsx`; `BookingPaymentFlow` is not used for services (pay at provider); at-home flow captures
  address + access notes; pay-at-provider shows "you pay {provider} on the day".
- My bookings: upcoming/past, reschedule/cancel per policy, add to calendar, review after
  completion. Family profiles (book for a dependant) in phase 3.
- Vitana: ORB tools `find_services`, `get_slots`, `book_service` (risk `high`: read-back +
  explicit confirm, as the existing ORB `confirm` pattern for `high`-risk tools), Autopilot proposes, never books silently.

## 7. Provider experience (Business mode)

- **Bookings inbox** (new, Commerce Portal + mobile): requests to confirm/decline, today's
  schedule, calendar view per practitioner, reschedule, mark completed / no-show.
- **At-home operations** (phase 3): assign practitioner, "en route / arrived" status with
  optional live location shared only during the visit, travel-time aware slotting (Amazon
  Location route matrix), checklist per service, visit notes (non-clinical; clinical records stay
  in the provider's own system — we do not become an EHR).
- **Team**: practitioners linked to org members (`professional` role exists), per-practitioner
  services and calendars.
- **Payouts**: none in pay-at-provider mode; commission statement + invoice instead. Connect
  payouts only if D-S1 is decided.
- **Notifications**: push + email for new request, cancellation, upcoming visit, expiring
  credential.

## 7b. Capability contracts — one definition, four front doors

```
services/gateway/src/contracts/<capability>.ts     (new)
  export const bookService = defineCapability({
    id: 'booking.create', audience: 'member', risk: 'high',
    input: zodSchema, output: zodSchema,
    confirm: 'two_step',               // hold → confirmed=true (+ in-app confirm when fee/address)
    handler: bookingService.create,     // the ONE implementation
  });
```
- **This is a new subsystem**, at `services/gateway/src/contracts/` (not under `capabilities/`).
  The existing `capabilities/index.ts` is a different thing — it resolves voice intents such as
  `music.play` / `calendar.create` to connected-app connectors — and stays untouched. Separate
  namespace (contract ids use the prefixes `commerce.*`, `booking.*`, `discover.*`), separate
  resolver, no imports in either direction. S0's estimate includes building this layer from scratch.
- **What is generated vs hand-written:**
  - *Generated* from the contract: the **MCP tool definition** (name, description, JSON schema from
    zod, annotations — `readOnlyHint` for reads, `destructiveHint` for cancel/decline) and the input
    validation used by app routes.
  - *Hand-written thin adapter* for **ORB tools**: ORB tools live in `orb/live/tools/` and are
    registered via `live-tool-catalog.ts` with session context, the read-back/confirm flow for
    `high`-risk tools, and the Vertex tool-catalog byte budget (`vertex-tool-catalog-budget.ts`). Each
    ORB adapter is ~20 lines: take session identity, call the contract's `handler`, map the result to
    a spoken intent. A test asserts every ORB adapter's parameters are a subset of the contract's
    schema, so they cannot drift even though they are not generated.
  - App routes call the same `handler`.
- **Shared MCP core** `services/gateway/src/mcp/` (new): JSON-RPC handling, version negotiation,
  `toolOk/toolError`, the safety envelopes, rate limiting and grant checks — extracted from
  `commerce-mcp.ts`/`community-mcp.ts` as a thin layer the existing registries delegate to (S0);
  the existing tools move onto contracts only after the layer has shipped (S1).
- **Rate limits:** reads keep today's in-memory 120/min/user budget, split **per connector**. Writes
  with consequences (`hold_slot`, `book_service`, `cancel_booking`, `confirm_booking`,
  `decline_booking`, `mark_completed`) use a **durable** sliding window in the existing Redis
  (`services/redis-client.ts`) shared by all gateway tasks: 5 holds/min and 3 bookings/min per
  member, 30 booking-state changes/min per org; if Redis is unreachable these tools fail closed
  (429) rather than fall back to per-process counting. Existing 9 Commerce + 4 Community tools move onto contracts in S0 without
  changing names, schemas, annotations or behaviour (contract tests pin both `tools/list` outputs
  byte-for-byte, and the VTID-05133 / VTID-04938 test suites must stay green).
- Each contract carries a policy tier (read/draft/commit/high) matching `orchestrator/tool-catalog.ts`'s `classifyOrbTool` tiers, so ORB policy and MCP behaviour agree.
- Grants: `ai_connection_grants` (existing) is the only grant store; each member contract names its
  grant category; the shared core refuses a call whose category is not granted (today's behaviour).

**Tool list (target):**

| Vitanaland connector (businesses) | Maxina connector (members) |
|---|---|
| existing 9: get_onboarding_status, create_business, update_business, add_product, list_products, update_product, check_verification, connect_store, submit_for_verification | existing 4 (profile/matches/people/activities): get_my_maxina_profile, get_my_matches, find_people, find_activities |
| new (S1): add_service, set_availability, list_bookings, confirm_booking, decline_booking, mark_completed | new `services` category (S2): find_services, get_service, get_slots, hold_slot, book_service, my_bookings, cancel_booking, find_products (affiliate links only) |
| | new `health_*` categories (track H, own plan): see §7c |

## 7c. Track H — health records in the Maxina connector (owner decision D-S6)

The owner wants members to be able to bring their own health records into their own AI assistant.
This plan fixes *how*, so the track's own work-package plan starts from agreed constraints:

1. **Gates before any code:** Health Hub Phase 0L (DPIA, DPO, DPAs) done and naming member-chosen AI
   assistants as recipients; D10 (per-category `ai_health_analysis`-style consent) built; its own
   sparred plan approved. Off in production until then (`COMMUNITY_MCP_HEALTH_ENABLED`).
2. **Shape:** read-only, the member's **own** data only, one grant category per health category
   (`health_labs`, `health_wearables`, `health_index`, …) on `ai_connection_grants`, each requiring a
   matching active Art. 9 consent in the Health Hub consent store; withdrawing either stops access
   immediately. Summaries, not raw streams (no 5-minute samples).
3. **Wellness purpose:** tool output stays inside the Health Hub §2 catalogue (no diagnosis labels,
   disease-risk statements or dosing); tool descriptions say so; values are returned as the member's
   data with reference ranges as provided by the lab, never interpreted by us.
4. **Region:** never for `data_region` other than `'eu'` (UAE Federal Law 2/2019 Art. 13; KSA).
5. **Audit:** every call logged in the Health Hub `health_access_log` (non-owner read) with client id;
   member sees the access history in Settings → Connected AI.
6. **Never into commerce:** health tools and service/booking tools are separate categories; a
   connector call that returns health data never also ranks services (CI boundary test covers both).

## 8. Native mobile plan (own shell replacing Appilix — to be re-confirmed, see §11)

| Topic | Decision |
|---|---|
| Shell technology | Capacitor shell around the existing web app replacing Appilix (pending owner re-confirmation, §11); background location, document picker and push via native plugins |
| Apps | **One codebase, two store apps**: *Vitanaland* (members + business mode for owners) and, from phase 3, *Vitanaland Business* (field staff: job list, navigation hand-off, en-route/arrived, offline-tolerant). Reason: background location + field-staff onboarding would otherwise burden the member app's store review and privacy labels |
| Payments in app | Services are consumed outside the app → App Store 3.1.3(e): **no in-app purchase**, Apple/Google Pay or card via Stripe/PSP allowed. Business listing plans (if any) sold on web only; app shows no purchase UI for them |
| Checkout UI | No `window.open` popups (breaks in WebViews); use Stripe Payment Sheet / in-app browser (SFSafariViewController / Custom Tabs) |
| Push | Native APNs/FCM via the shell; topics per role: member booking updates, provider new-request alerts (time-critical), credential expiry |
| Deep links | Fix the bundle mismatch: AASA (`com.exafy.maxina`) vs assetlinks (`com.vitanaland.app`) → one bundle per app; routes `/discover/service/:id`, `/bookings/:id`, `/commerce/bookings/:id` |
| Camera / files | Credential upload by camera scan (native document picker) |
| Location | Member: when-in-use only (near me). Field staff app: background only during an active visit, with visible indicator |
| Health data | Booking data is not HealthKit data; no HealthKit sharing with providers in this plan |
| Store compliance | Apple 1.4.1 / 5.1.1 (health apps submitted by legal entity, account deletion incl. business accounts), Google Play health-apps declaration + data safety; all data in the EU region (CH included) |
| Trust anchor for agents | Bookings started in Claude/Vitana that need in-app confirmation arrive as a push → confirm sheet; Settings → Connected AI (existing `ConnectedAiSection.tsx`) shows the new categories with revoke |
| Phone parity | Remove `hidden lg:block` gaps in Commerce Portal; every provider task doable at 390 px |

## 9. Phases (each phase = its own VTID + sparring before code)

| Phase | Scope | Exit criterion |
|---|---|---|
| **S0 Foundations** (3 w) | Contract layer + shared MCP core as a **thin extraction** (JSON-RPC, version negotiation, envelopes, grant check, rate limits) that today's two registries delegate to — existing tool definitions do not change shape in S0 (pinned `tools/list`, existing VTID-05133/04938 suites green); new tools are the first contract users; moving the 13 existing tools onto contracts is a separate, later PR inside S1 once the layer has shipped, `commission_agreement` checklist step, `offering_type`, `offering_service_details`, locations, practitioners (PII-safe projection), requirement sets + `supplier_evidence` for DE/AT/CH; portal "Service" path; fix mobile gaps in portal | A staging supplier can list a service with evidence; read-only staging suite proves listing visible on Discover; `/commerce` exclusion reason updated (§10) |
| **S1 Bookable services** (3–4 w) | Business MCP tools for services/availability/bookings (same PR as the UI), availability rules/exceptions, slot engine with no-double-book constraint, `service_bookings` + events, bookings inbox, member booking flow (pay at provider), notifications, commission ledger + monthly statement, real Discover services (replace mocks) | Slot engine + `btree_gist` extension + `tstzrange` exclusion constraint (created in the same migration file) + RLS tested against real Postgres (the `postgres:16` service already in `CICDL-GATEWAY-CI.yml` and SQL tests in `supabase/tests/`); timezone and cancellation-policy tests; staging read-only suite renders real slots; every new route in the screen registry |
| **S2 Agents book** (2–3 w) | `services` grant category on the Maxina connector + consent/Settings toggles, two-step booking contract, in-app confirmation (push or emailed single-use link) for bookings with a fee, an at-home address or data sharing (D-S8), ORB tools + Autopilot proposals from the same contracts, verified reviews | Contract tests: no booking without `confirmed=true` + valid hold; fee/address bookings stay `pending_member_confirmation` until in-app confirm; revoked grant → 403; prompt-injection fixtures in listing text do not change tool behaviour; email confirmation fallback tested (token generation, single-use signed link, expiry equal to the hold TTL, template in DE/EN/AR) |
| **S3 At-home ops + Business app** (4–6 w) | Amazon Location Service (own infra VTID first), radius/map/near-me, travel fees, assignment, en-route/arrived, field-staff app target, calendar busy-sync | Field app in TestFlight/internal track |
| **H Health records in the Maxina connector** (after Health Hub 0L + D10) | §7c, own sparred plan | DPIA approved; consent + grant both required; EU only; boundary test green |

## 10. Testing and governance

- No production writes or tests; staging suites read-only; all writes proven by gateway Jest +
  migration tests (slot engine, constraint, RLS: member sees own bookings, org members see their
  org's bookings, nobody sees another org's; practitioner PII never in public projection).
- Test/service accounts excluded from Discover and from booking notifications (`service_bot_accounts`,
  `notification_test_actors`, existing `listing_hold='excluded_account'`).
- i18n: DE first, then all shipped locales; RTL for Arabic; dates via `@/lib/locale-format`.
- Screen registry (VTID-04502): every new route goes into `src/navigation/registry/screens.json`
  with DE/EN (and AR) phrasings and locale titles, or `exclusions.json` with a reason — an exit
  criterion of every phase: every new member-facing route (`/discover/services`,
  `/discover/service/:id`, `/bookings`, `/bookings/:id`) goes into `screens.json` with DE/EN/AR
  phrasings; provider-only routes stay in `exclusions.json` with a reason (see below).
- Spotlight Design Contract (VTID-05107, v1 CLAUDE.md): every new v1 page gets an archetype in
  `src/design/screen-manifest.json` and composes with `ScreenFrame` + `VCard`, design tokens only.
- Commerce Portal and the provider bookings inbox stay in `exclusions.json` with an updated reason
  (business surface, served by the commerce Vitana persona, not member voice navigation); member
  routes (`/discover/services`, `/discover/service/:id`, `/bookings`, `/bookings/:id`) go into
  `screens.json`.
- What's New entry per user-facing phase (DE + EN, du-form).
- LLM features (AI service drafting, Vitana booking) via `callViaRouter` on Bedrock, user locale injected.
- Commerce–health boundary: the Jest test `services/gateway/test/vtid-05025-commerce-health-boundary.test.ts`
  (runs on every PR) is extended to the new booking/Discover-service modules; the staging spec
  `e2e/staging/vtid-05025-commerce-health-boundary.staging.spec.ts` gains a read-only assertion that
  `find_services` results are identical for two members with different health data.
- MCP: contract test of `tools/list` per connector (names, schemas, annotations); every MCP tool has an
  integration test through the same handler as its app route; staging probes for MCP are read-only
  (`tools/list`, `get_onboarding_status`, `find_services`) — never `book_service` against staging,
  which writes to the production database.

## 11. Owner decisions (recorded 2026-10-13) and what is still open

| # | Decision | In this plan |
|---|---|---|
| D-S1 | Members pay the provider directly | §3.2; no Vitana checkout for services |
| D-S2 | Commission per completed booking | §3.2 `commission_agreement`, `commission_ledger_entries` |
| D-S3 | Platform routing to licensed facilities (no own DHA licence) | §3.1, §5 |
| D-S4 | Separate field-staff app | §8, S3 |
| D-S5 | Never list peptides, HRT, compounded injectables, "whitening" drips | §5 requirement sets block these categories |
| D-S6 | Health records in the member connector | §7c track H, under Health Hub gates |
| D-S7 | Two connectors: **Vitanaland** (businesses) and **Maxina** (members, tenant-bound) | §0, §7b |
| D-S8 | In-app confirmation for agent bookings with a fee, an at-home address or data sharing | §1b, S2 |

| — | Market entry DE, AT, CH first; Spain, UAE, KSA later | §0, §5; no Gulf phase in this plan |

**Delegated by the owner ("You decide for me", 2026-10-13) and decided by the planner:**
- **Native shell:** our own Capacitor shell replaces Appilix (independence, as the owner chose on
  2026-09-29); it gets its own sparred plan and VTID before S3.
- **Gulf data plane:** not needed for a DACH launch; the `data_region` CHECK stays `'eu'`
  (Switzerland is served from the EU region — Swiss law recognises the EU as adequate). The
  question is reopened only when a Gulf market is planned.
- **VTID-04743** (the External Agent design doc of closed PR #3822): terminalized as cancelled,
  superseded by this plan.

<!-- plan:end -->
