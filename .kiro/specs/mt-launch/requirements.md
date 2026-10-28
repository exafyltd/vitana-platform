# Requirements — mt-launch (WS8 Tenant Launch engineering)

Program: `docs/MULTI-TENANT-PLAN.md` (v5.1, §6 WS8). This spec covers WS8 **engineering only**; it links the program
records instead of copying them. Non-engineering launch steps are owner/ops actions (see `plan.md` Out of scope / Owner
decisions).

## Program position
- **Predecessors (done):** VTID-05149 (`tenants.is_default`/`is_platform`, `TenantContext`, `ci_tenant_isolation_health`),
  VTID-05150 (brand pack columns, `provision_tenant`, exafy_admin provisioning API + readiness + assets),
  VTID-05151 (public tenant registry). Live infra: `product_analytics_events` + rollups, `feedback_tickets`,
  `referrals`/`sharing_links`/`signup_attempts`.
- **Sibling specs this one depends on:** `mt-packs` (creates `tenant_content_overrides` + the drafter — the publish
  target), `mt-identity` (canonical `isHealthTable()` predicate — O1), `mt-guardrails` (WS0 lint/golden harness).
- **Successors:** `mt-native-health` (WS9/native analytics + landing; M2 here is web-only), `mt-discover`
  (Discover/supplier gates), `mt-m3` (switching UI, offboarding).

## This spec

### R1 — Tenant pack intake data model (lane `pack-intake-db`)
1. THE SYSTEM SHALL record, per tenant, the launch intake checklist (identity + anchor-person consent, brand kit, copy,
   persona facts, brand KB docs, Season 0 approval, 90-day events calendar, seed groups, host/moderator/support SLA,
   ≥30 founding invites, revenue share, locales, health-claims sign-off) with a status in
   `not_started | in_progress | blocked | approved`.
2. THE SYSTEM SHALL record, per tenant and locale and content key, a content-pipeline row with its source template,
   candidate value, lint report, and review state in `generated | linted | in_review | signed_off | published | rejected`.
3. Both tables SHALL be service-role-only (no client RLS), mirroring `product_analytics_events`.
4. THE SYSTEM SHALL expose a read-only `get_tenant_launch_readiness(p_tenant_id)` that reports intake completeness and
   SHALL NOT read any health table.

### R2 — AI-assisted content pipeline (lane `pack-intake-admin`)
1. WHEN an exafy_admin requests candidate content THE SYSTEM SHALL generate it from Maxina templates and run three
   linters: health-claim, leftover-brand (`Maxina`/`Mariia` outside immutable identifiers), undated-time-bound-claim.
2. THE SYSTEM SHALL block publish while any health-claim or leftover-brand finding is open; undated-claim findings SHALL
   warn only.
3. THE SYSTEM SHALL publish a content row to `tenant_content_overrides` ONLY from the `signed_off` state, then seed i18n.
4. THE pipeline SHALL be dark by default behind `tenant_settings.feature_flags.mt.launch_pipeline`.
5. Intake/pipeline write endpoints SHALL enforce exafy_admin (or tenant-admin per item) and tenant isolation; a
   tenant-admin of another tenant SHALL get 403/empty.

### R3 — Tenant-owner analytics (lane `tenant-owner-analytics`)
1. THE SYSTEM SHALL expose per-tenant owner analytics for signups, activation, journey, events and retention from
   `product_analytics_events`/rollups, tenant-scoped via `requireTenantAdmin` + the tenant path segment.
2. THE owner-analytics code SHALL NOT read any health table; unknown-provenance tables SHALL count as health
   (deny-by-default). A build-failing source-scan guard SHALL enforce this (D18).
3. Owner analytics SHALL be dark behind `mt.launch_analytics`.

### R4 — Support routing & landing (lane `support-landing`)
1. THE SYSTEM SHALL resolve a tenant's support answerer, SLA and support contact from `tenants.support_email`/`sender_*`
   and a `mt.support` settings block, applied where `feedback_tickets` are created/triaged, so a tenant's tickets carry
   its routing.
2. THE SYSTEM SHALL surface the launching tenant's landing SEO/OG metadata from the brand pack through the public
   registry read path; the invite `/claim` attribution OASIS event SHALL carry the claiming member's tenant (never
   `DEFAULT_TENANT_ID`); signup attribution in `admin-signups.ts` is fixed by mt-jobs VTID-05267, not here.
3. Support routing SHALL be dark behind `mt.launch_support`.

### R5 — CI gate (lane `worker-test-gate`, executor claude)
1. THE three linter suites, the D18 analytics lineage guard, and the unchanged Maxina golden assertion SHALL run in
   PR-GATE / the gateway Jest job so WS8 code cannot merge without them.

## Standing rules (apply to every lane)
Never test against production (CLAUDE.md 31/31b/48); staging tests read-only; dark by default; migrations applied by
Claude via RUN-MIGRATION in MIGRATION-QUEUE order; test/service/platform-only accounts invisible to members (rules
43–45); i18n DE-first du-form + RTL via logical properties; Spotlight contract; Bedrock-only AI, no Google beyond the
carve-outs; `npm run test:support` (42c) and `npm run test:operator` (42e) stay green when their pipelines are touched.

## Not in this spec
WS5 content/persona and `tenant_content_overrides` creation; per-tenant money/invoicing/Stripe; native app analytics
and landing (web-only M2); Network-scope analytics beyond aggregate; the non-engineering owner/ops launch actions.
