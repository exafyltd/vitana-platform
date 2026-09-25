# Health Data Integration Plan — phones, wearables, labs and providers (VTID-04538)

**Status:** proposal, awaiting owner decisions (§11). Docs only, nothing built yet.
**Scope:** how members bring health data into Vitanaland from Apple Health, Android
Health Connect, wearables and lab/medical providers, and how they share it with
commerce partners (lab test providers, practitioners and clinics). The plan is written
to satisfy GDPR/DSGVO for **both** sides: community members and commerce service
providers.

> This is an engineering plan with the data protection requirements built in. It is
> not legal advice. Every item marked **[LEGAL]** needs sign-off from counsel and a
> data protection officer before it ships to production.

---

## 1. What exists today (verified in both repos, 2026-09-25)

The backend has more than the product shows. Nothing reaches a member end to end.

| Area | What exists | Gap |
|---|---|---|
| Connector framework | `services/gateway/src/connectors/` (Terra, Vital, Fitbit, Oura, Strava, DoctorBox, SMART-on-FHIR), `/api/v1/wearables/*`, `/api/v1/connectors/webhook/:id` | No sync scheduler (`fetchData` is never called), no wearable token refresh, OAuth redirects go to `/ecosystem`, which vitana-v1 has no route for |
| Storage | `user_connections`, `wearable_daily_metrics`, `wearable_workouts`, `wearable_samples`, `health_features_daily`, `lab_reports`, `biomarker_results` | **OAuth tokens stored as plain TEXT.** Two pipelines that never meet: connector data lands in `wearable_daily_metrics`; the Vitana Index reads `health_features_daily` |
| Webhooks | HMAC checks for Terra, Vital, DoctorBox | **Signature check is skipped when the secret is unset** ("dev mode"), so it fails open |
| Phone health apps | none | App is an Appilix WebView. **No HealthKit, no Health Connect is possible from the web layer.** The iOS companion app the Terra connector refers to does not exist |
| Frontend | `ConnectedApps.tsx` health cards | **Hard-coded `connected: true, lastSync: '2 minutes ago'` demo cards** for Apple Health, Fitbit, Oura, Garmin and others. Nothing calls `/api/v1/wearables` |
| Lab uploads | `HealthReportUploadSheet` → `health-reports` bucket + `lab_reports` row (VTID-04044) | Nothing parses uploads; status stays `uploaded` forever |
| Partner results | `ingestPartnerResult()` (VTID-03885): idempotent, consent-checked, quarantine inbox | Only a DoctorBox adapter; self-registered labs (`partner_key = org_key`) likely fail or fall back to the wrong key |
| Consent | `data_sharing_consents` + append-only `data_sharing_consent_events`; VCAOP `consent_grant`/`consent_receipt` (dormant, insurer-oriented) | Consent means "partner may push results *into* Vitana". **No grant from a member to a provider to *see* data.** No per-source consent for wearable collection |
| Provider access | `requirePartnerHealthAccess` + `org-access.ts` | Staff link a member to an order **without the member confirming**. Staff reads are **not logged**. No provider view of a patient's results (placeholder page) |
| Privacy UI | `Settings › Privacy` | "Health data analytics" and "Third-party integrations" switches are **uncontrolled, with no handler**. "Request data export" does nothing |
| Erasure | `request-account-deletion` edge function | **Does not delete** `lab_reports`, `biomarker_results`, `wearable_*`, `health_features_daily`, `vitana_index_scores`, `user_connections` or the `health-reports` bucket. Health tables have no FK to `auth.users` |
| Legal artefacts | onboarding checklist has a `dpa` step | No DPA text, no `/dpa/sign` endpoint, no DPIA, no records of processing, no MDR assessment |

The bold rows are **compliance defects in what is already live**. They are Phase 0
and come before any new data source.

---

## 2. Target picture

```
 MEMBER DEVICES & ACCOUNTS                 VITANALAND (AWS eu-central-1)                      COMMERCE PARTNERS
 ─────────────────────────                 ───────────────────────────────                    ──────────────────
 Apple Health (iOS) ─┐                     ┌────────────────────────────┐
 Health Connect ─────┤─ native shell ──────▶  Ingestion gateway          │
   (Android)         │   (on-device read,  │  • consent check per source│◀── lab results (webhook / FHIR / portal upload)
                     │    member-chosen    │  • signature check,        │       from labs and clinics
 Oura, Fitbit/Google,│    types only)      │    fail closed             │
 Withings, Garmin,   ├─ OAuth / aggregator ▶  • normalise → observations │
 Whoop, Polar, Strava┘                     │  • provenance + consent_id │
                                           └─────────────┬──────────────┘
 Uploaded PDF/photo ── parser (Bedrock) ──────────────────┤
                                                           ▼
                                  health_observations (one canonical store)
                                     │                         │
                                     ▼                         ▼
                        health_features_daily        member-to-provider GRANTS
                        → Vitana Index, ORB,          (org, scope, purpose, expiry)
                          recommendations                      │
                                                               ▼
                                              provider views (gateway only, every read logged)
                                              ──▶ member sees "who viewed what, when"
```

Six principles:

1. **One canonical store.** Every source lands in one normalised observation table with
   provenance, never in per-source islands.
2. **No consent, no ingestion.** Every source and every data category needs a live
   consent record before a single value is stored.
3. **Nothing leaves the member without a grant.** Providers see data only through an
   explicit, scoped, time-limited, revocable grant from the member.
4. **Every access is logged**, and the member can see the log.
5. **Minimise.** Import the categories the member picked, at the resolution the features
   need. Raw payloads are kept briefly for debugging, not forever.
6. **Fail closed.** A missing secret, missing consent or unmatched member means the data
   is quarantined, not accepted.

---

## 3. Data sources: how each one connects

### 3.1 Apple Health (HealthKit) — needs a native layer
HealthKit has **no web or cloud API**. It can only be read by native iOS code running on
the member's phone. The Appilix WebView cannot reach it. There are three options, decided
in §11-D1:

| Option | How | Pros | Cons |
|---|---|---|---|
| **A. Move the shell to Capacitor (recommended)** | Keep the React app; add `ios/`/`android/` projects; a HealthKit/Health Connect plugin reads data on device and posts batches to the gateway | One codebase, full control, no third party in the data path, also unlocks Health Connect | Replaces Appilix (push notifications, drawer bridge, IAP flags need porting); App Store review |
| B. Aggregator mobile SDK in a small companion app | Terra/Vital/Thryve SDK embedded in a thin native app | Fastest to get many sources | Second app for members to install; aggregator becomes a processor (US hosting → transfer rules) |
| C. Manual export upload | Member exports `export.zip` from the Health app and uploads it | No native work | Poor UX, one-off snapshots only. Useful only as a stopgap |

Apple's rules that shape the design (App Store Review Guideline 5.1.3 and HealthKit terms):
- HealthKit data may not be used for advertising or marketing, or sold to or shared with
  data brokers or ad platforms.
- It may be shared with a third party only to provide a health service, and only with the
  member's consent.
- Data must not be stored in iCloud. A privacy policy is mandatory.
- The app must request only the types it uses, and explain each one in the permission prompt.

**Consequence for commerce:** HealthKit-derived data may never feed affiliate
recommendations, product ranking or partner marketing. It may be shared with a provider
only through a member grant for a health service (§5).

### 3.2 Android — Health Connect
Google Fit's APIs are being shut down; **do not build on them**. On Android the on-device
store is **Health Connect**, again native-only (the same Capacitor plugin as 3.1). Google
Play requires a Health Connect **permissions declaration** and a privacy policy, and
limits use to the declared purpose. Samsung Health, Withings and others write into Health
Connect, so one integration covers many devices.

### 3.3 Cloud wearables (works today from the web app)
Oura, Fitbit (now Google), Withings, Garmin, Whoop, Polar and Strava have server-side
APIs. We already have direct Fitbit/Oura/Strava connectors plus the Terra and Vital
aggregators.

- **Direct OAuth** for the big sources where we want no middleman in the data path
  (Oura, Withings, Fitbit/Google).
- **One aggregator** for the long tail (Garmin, Whoop, Polar, Coros and others), picked by
  where it is hosted and what DPA it offers (§11-D2). Prefer EU hosting; if the
  aggregator is US-based, we need an Art. 28 DPA plus SCCs or EU-US DPF certification, and
  a transfer impact assessment. **[LEGAL]**
- Missing pieces to build: a **sync scheduler** (EventBridge → gateway, the same
  pattern as the other crons), **token refresh**, webhook subscriptions where the vendor
  offers them, and a **real Connected Apps UI** in place of the demo cards.

### 3.4 Lab and medical results
| Path | Build |
|---|---|
| **Partner push** (a lab in our commerce portal sends results) | Generalise `ingestPartnerResult()` with an adapter per partner and a generic **FHIR R4 `DiagnosticReport` + `Observation`** adapter. Self-registered labs pick "FHIR webhook" or "portal upload" as their results channel during onboarding |
| **Portal upload** by partner staff | Already in the admin inbox; extend it to self-registered labs and fix the `partner_key` fallback |
| **Member upload** (PDF/photo of a lab report) | Parser: Bedrock vision (Claude via Bedrock, the standing rule) extracts biomarkers into a **draft** the member confirms before it is written to `biomarker_results`. No auto-trust of OCR |
| **Patient-side FHIR** (SMART on FHIR, existing OAuth connector) | Keep as an optional source. Germany's ePA is not open to third-party apps today, so no work there until the EHDS opens access (§9) |

Biomarkers are mapped to **LOINC** codes with UCUM units, so values from different labs
are comparable and can be exported in a standard format.

---

## 4. Data model

### 4.1 New and changed tables
| Table | Purpose | Key columns |
|---|---|---|
| `health_sources` | One row per connected source per member (replaces the health half of `user_connections`) | user_id, source_kind (healthkit/health_connect/oauth/aggregator/partner/upload), provider, status, consent_id, **token_ref** (Secrets/KMS reference, never the token), last_sync_at, sync_cursor |
| `health_observations` | Canonical store for every value | user_id, source_id, category (activity/sleep/heart/body/nutrition/lab/…), code (LOINC or internal), value, unit (UCUM), effective_start/end, device, provenance, consent_id, ingested_at |
| `health_consents` | Member consent per **purpose × category × source** | user_id, purpose, category, source_id?, granted_at, withdrawn_at, text_version, channel |
| `provider_access_grants` | Member lets a provider org or practitioner see data | user_id, partner_organization_id, practitioner_user_id?, scopes (categories), purpose, valid_from, valid_until, revoked_at, text_version |
| `health_access_log` | Append-only record of every read of member health data by anyone except the member | accessor_id, accessor_role, org_id?, subject_user_id, scope, grant_id, route, at. Monthly partitions (the `memory_audit_log` pattern) |
| `health_retention_policies` | Retention per table/category | category, keep_days, basis |

`wearable_daily_metrics`, `wearable_samples` and `health_features_daily` become
**derived** tables, computed from `health_observations`. That merges the two pipelines,
and the Vitana Index finally sees connector data.

`data_sharing_consents` stays for partner-to-Vitana ingestion consent. Its append-only
events table is the model for the new consent and grant event tables.

### 4.2 Security baseline (Art. 32)
- **Tokens:** encrypted with AWS KMS envelope encryption, or stored in Secrets Manager
  with only a reference in the database. Existing plaintext tokens are migrated and the
  columns dropped.
- **RLS:** member-owned tables use `user_id = auth.uid()` (the VTID-04044 lesson:
  `current_tenant_id()` is NULL for browser JWTs, so tenant-gated policies silently return
  nothing). Provider access never uses RLS. It goes through the gateway with the service
  role, **after** a grant check, and every read is logged.
- **Storage:** the `health-reports` bucket stays private, with signed URLs that expire
  after minutes.
- **Webhooks:** a missing secret means **reject**, in every environment except local dev.
- **Raw payloads:** kept 30 days, then deleted. Normalised observations are what persists.
- **LLM use:** health data sent to Bedrock stays in the EU region, is never used for
  training (Bedrock's default), and ORB prompts carry only the categories the member
  consented to for "AI coaching".

---

## 5. Sharing with commerce partners (labs, practitioners, clinics)

### 5.1 Who is controller of what **[LEGAL]**
| Processing | Vitanaland's role | Partner's role | Contract |
|---|---|---|---|
| Member's own health data in the app (tracking, Vitana Index, ORB) | Controller | — | Privacy notice + explicit consent (Art. 9(2)(a)) |
| Lab performs a test the member ordered; the lab sends the result to Vitana | Controller for the copy in the member's account | Independent controller for its own medical record | Partner terms + data-transfer clauses; member consent to receive |
| Member grants a practitioner access to their data | Controller (disclosing) | Independent controller for what they view/copy, bound by professional secrecy | Grant + partner terms |
| Partner uses Vitana's portal to manage **its own** patients' data | **Processor** for the partner | Controller | **Art. 28 DPA** (the checklist's `dpa` step), plus a §203 StGB secrecy undertaking for German practitioners |

Each partner's DPA also lists our sub-processors (AWS, Supabase, Bedrock, any aggregator).

### 5.2 Member flow — sharing with a provider
1. A provider appears to a member through an order, a booking or an invite link.
2. The member sees **exactly** what would be shared: the org and named practitioner,
   categories (lab results / wearable summaries / Vitana Index / diary), the period
   covered, the purpose and the expiry (default 90 days, or tied to the order).
3. The member explicitly confirms. **Staff can no longer link a member to an order
   without that confirmation.** `confirm-match` creates a *pending* link and the member
   accepts it in-app.
4. **Settings › Privacy › Shared with** lists every active grant, with a one-tap revoke,
   and an **access history** fed from `health_access_log`.
5. Revoking stops access immediately. Data the provider already copied into its own
   records falls under its own controller duties, and the UI says so plainly.

### 5.3 Provider flow — what staff can see
- Only orgs with `trust_level = 2` (verified, **signed DPA**, terms accepted) may receive
  health data. This is enforced in `requirePartnerHealthAccess`.
- Only named practitioners and staff inside the grant's scope. A professional sees only
  patients whose grants name them or their assigned orders.
- MFA is required for partner accounts with health scopes.
- The patient view shows only the granted categories and periods. There is no bulk
  export and no cross-patient search. The match-candidate list shows hashed or partial
  identifiers until the member confirms.
- Every read goes to `health_access_log`, including `GET /orders`, `/inbox` and
  `/candidates`, which are not logged today.
- **No health data in any commerce signal:** affiliate ranking, product recommendations
  and partner analytics use no health categories unless the member separately opts in
  to "personalised offers" (a separate purpose, off by default, never HealthKit-derived).

### 5.4 Partner onboarding additions
- `/dpa/sign`: versioned DPA acceptance, stored like `partner_terms_acceptances`.
- A `results_channel` step: FHIR webhook (signed), portal upload or manual.
- A professional-secrecy and staff-confidentiality confirmation for practitioner clinics.
- Offboarding: when an org leaves, its grants are revoked, its access is closed and any
  processor data is returned or deleted per the DPA.

---

## 6. Consent design (members)

GDPR Art. 9 makes health data a special category. The basis here is **explicit consent**
(Art. 9(2)(a)). Consent must be specific, informed and unbundled, and as easy to
withdraw as to give (Art. 7(3)).

| Purpose | Default | Categories |
|---|---|---|
| Store and show my health data | off until the first source is connected | per category, chosen at connect time |
| Vitana Index and insights | on the connect screen, separate tick | categories the member picked |
| AI coaching (ORB) uses my health data | separate tick | subset |
| Share with a named provider | per grant (§5.2) | per grant |
| Personalised offers from partners | **off**, never pre-ticked | no HealthKit or Health Connect data, ever |
| Anonymised research / product improvement | **off** | aggregate only, after anonymisation review **[LEGAL]** |

- The connect screen for each source shows the categories as toggles, not an
  all-or-nothing switch. The native OS permission prompt then asks for exactly those.
- Consent texts are versioned, stored per member, and available in all 11 locales
  (i18n rule: German first, du-form).
- Withdrawal stops syncing, disconnects the source, and deletes or keeps the data as the
  member chooses at that moment.
- **Minors:** health features are gated to 16+ (the German Art. 8 age), or require parental
  consent. **[LEGAL]**
- Fix today's fake switches in `Privacy.tsx` by binding them to `health_consents`.

---

## 7. Member rights, retention and deletion

| Right | Implementation |
|---|---|
| Access / portability (Art. 15, 20) | "Download my health data": a ZIP with JSON, **FHIR R4 Bundle** and CSV, built by an async job and delivered by signed link |
| Erasure (Art. 17) | Extend `request-account-deletion` to every health table and bucket. Add FK `ON DELETE CASCADE` or a deletion registry. Notify grant-holding providers. Aggregator and vendor deregistration (Terra/Vital deauth) is part of the job |
| Rectification (Art. 16) | Members can correct parsed lab values; the original is kept for provenance |
| Restriction / objection | Pause per source or per purpose |
| Transparency | A "What we do with your health data" page per source, linked from every connect screen |
| Retention | Raw payloads 30 days; observations while the account is active; access logs 3 years (proposed, **[LEGAL]**); consent records for as long as needed to prove consent |

The existing 30-day SLA scanner (`admin-scanners/compliance.ts`) is extended to health
deletions.

---

## 8. Legal and governance workstream **[LEGAL]**

Must be done before production. None of these are engineering tasks, but engineering is
blocked on several of them.

1. **DPIA (Art. 35)**: mandatory for large-scale health data processing. Covers every
   source, sharing with providers, AI use and third-country transfers.
2. **Data Protection Officer (Art. 37, §38 BDSG)**: required when core activities include
   large-scale special-category processing.
3. **Records of processing (Art. 30)** for each purpose in §6.
4. **Processor DPAs and transfer mechanisms** for AWS, Supabase, Bedrock and the chosen
   aggregator, plus a sub-processor list published for members and partners.
5. **Partner DPA template, partner terms (publish `PARTNER_TERMS_VERSION`) and the
   §203 StGB secrecy clause.**
6. **Medical Device Regulation check (MDR 2017/745):** keep Vitana Index, insights and
   ORB to wellness and lifestyle claims. Anything that diagnoses, predicts disease or
   recommends treatment could make the software a medical device. Assess before
   biomarker interpretation ships.
7. **App store declarations:** Apple HealthKit usage strings and privacy nutrition label;
   Google Play Health Connect declaration and Data safety form.
8. **Privacy policy update** covering each source, sharing with providers, and transfers.
9. **Breach process (Art. 33/34):** a 72-hour notification runbook that includes partners
   as recipients.

---

## 9. Future-proofing: European Health Data Space

The EHDS Regulation (in force 2025, phased in from 2027) gives patients rights to access
and share their electronic health data in a European exchange format, and brings
"wellness apps" that claim interoperability with health records under labelling rules.
Storing labs as LOINC/UCUM and exporting FHIR (§3.4, §7) keeps us compatible. Revisit
ePA/EHDS access when member-side APIs open.

---

## 10. Phased delivery

Each phase is its own VTID(s) and PRs. Staging first. Every write-path verification uses
unit/integration tests or a local Supabase, **never production** (vitana-v1 absolute rule).

| Phase | Content | Depends on |
|---|---|---|
| **0 — Fix what is live** (2–3 wks) | Encrypt tokens (KMS) and drop plaintext columns · webhooks fail closed · remove the fake "connected" cards and wire the real `/api/v1/wearables` list · bind the Privacy toggles and the export button · extend erasure to all health tables and the bucket · log staff reads on partner-health routes · require member confirmation for `confirm-match` · fix the `partner_key` fallback and verify tenant-gated RLS on orders/results/consents | none |
| **1 — Consent and canonical store** (3–4 wks) | `health_consents`, `health_sources`, `health_observations`, `health_access_log`, retention · merge pipelines into `health_features_daily` · consent screens (11 locales) · health data export (JSON/FHIR/CSV) | DPIA draft, privacy policy draft |
| **2 — Cloud wearables** (3–4 wks) | Sync scheduler + token refresh · direct Oura/Withings/Fitbit-Google · one aggregator for the long tail · real Connected Apps screen with per-category toggles | §11-D2 |
| **3 — Labs** (4 wks) | Generic FHIR result adapter + adapter per partner · onboarding `results_channel` and `/dpa/sign` · member upload parser with a confirm step · LOINC/UCUM mapping | Partner DPA + terms published |
| **4 — Provider sharing** (4 wks) | `provider_access_grants` · member grant and revoke flow · "Shared with" and access history · provider patient view (replaces the placeholder) · trust-level-2 gate, MFA | Phases 1 and 3, DPA signed by the first partner |
| **5 — Phone health apps** (6–8 wks) | Capacitor shell (port the Appilix bridge: push, drawer, IAP) · HealthKit + Health Connect plugins · background delivery · App Store / Play declarations | §11-D1, Phase 1 |
| **6 — Hardening** | External pen test of provider access · DPIA sign-off · audit of the access log with the DPO · EHDS readiness review | all |

Phases 2 and 3 can run in parallel after Phase 1. Phase 5 can start its shell work in
parallel with Phase 1, because it does not touch health data until the store exists.

### Acceptance signals per phase
- **0:** no plaintext tokens left in any row; an unsigned webhook gets 401 on staging;
  deleting a test account (local Supabase) leaves zero rows in any health table.
- **1:** every observation row has a non-null `consent_id`; withdrawing consent stops
  the next sync (integration test).
- **2:** a connected staging test source produces observations and moves the Vitana Index.
- **3:** a FHIR `DiagnosticReport` fixture becomes `lab_reports` + LOINC-coded
  `biomarker_results`; an unmatched member goes to the inbox.
- **4:** a practitioner without a grant gets 403; with a grant, sees only the granted
  categories; each read appears in the member's access history.
- **5:** on a real device, only the member-chosen HealthKit types are requested and
  synced.

---

## 11. Decisions needed from the owner

| # | Decision | Recommendation |
|---|---|---|
| D1 | App shell for HealthKit/Health Connect | **Capacitor**, replacing Appilix. The only option that reaches both stores without a second app or a third party in the data path |
| D2 | Aggregator for long-tail wearables | One aggregator with **EU hosting and an Art. 28 DPA** (evaluate Thryve, Terra, Vital); direct OAuth for Oura/Withings/Fitbit-Google |
| D3 | External counsel and DPO | Appoint before Phase 1 goes to production; DPIA starts now |
| D4 | Default grant expiry | 90 days, or the end of the order, whichever is sooner |
| D5 | "Personalised offers" from health data | Keep it off at launch; revisit after the DPIA |
| D6 | Access log retention | 3 years, pending counsel |
