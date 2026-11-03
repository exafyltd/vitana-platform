# Requirements — mt-discover (Commerce & Discover × tenancy, WS11 + Discover scope of §4.11) — mt-discover-r2 (re-plan)

Links (read, do not copy):
- Program plan + decisions: `docs/MULTI-TENANT-PLAN.md` §4.9, §4.10, §4.11, §6 (WS11), §5 (D7, D26).
- Commerce architecture: `docs/COMMERCE-SUPPLIER-INFRASTRUCTURE-ARCHITECTURE.md` (§5.7, §7, §9).
- Migration order + lane ranges: `docs/multitenancy/MIGRATION-QUEUE.md`.
- Cross-spec rulings: this program's CROSS-SPEC decisions (O5 platform_only_accounts; network groups in mt-network-r2).
- Commerce UX contract (supplier screens): `vitana-v1/CLAUDE.md` "Commerce UX contract".
- Done: VTID-05149 / 05150 / 05151 (M0, in production); VTID-04732 (commerce arch, design only).

## Program position
- Predecessors: mt-identity-r2 is NOT required (this spec uses the existing `current_tenant_id()` + an inline `user_tenants`
  EXISTS; adopting its `is_member()`/`tenant_id_for_policies()` later is a follow-up), mt-community-isolation
  M2 (`platform_only_accounts` view — referenced, not created here, O5), M0 lanes A/B/C.
- Successors: mt-m3 (per-tenant money, custom domains); the commerce program (eligibility engine, commission ledger).
- Sibling: mt-network-r2 owns messenger/Network-groups scope; mt-discover owns ONLY Discover + offering distribution.

## EARS requirements
- R1 WHEN a DISCOVERY `products`/`merchants` reader runs for a resolved tenant — any open feed/search/browse query,
  OR a by-id lookup that INITIATES a new discovery action (e.g. creating a product recommendation) — the system SHALL
  apply ONE shared Discover visibility predicate (v1: `is_active` AND an active `supplier_tenant_relationships` row
  for the tenant AND no `tenant_catalog_overrides` hide, PLUS the scope term) and SHALL NOT return offerings a
  supplier is not active for; a FULFILMENT reader (a by-id lookup that HYDRATES an item the member already has —
  cart/saved/in-flight/past order/reorder) SHALL resolve the known item unfiltered.
- R2 WHERE an offering has `distribution='community'`, the system SHALL show it only in tenants whose supplier has an
  active relationship; WHERE `distribution='network'`, the system SHALL show it in every tenant, in both cases minus
  that tenant's `tenant_catalog_overrides` hides (applied in BOTH Community and Network mode).
- R3 WHEN a new `products`/`merchants` reader is added, a GENERATED inventory + build-failing lint SHALL classify it
  into exactly one of three dispositions and fail on anything unclassified: `discovery` (surfaces not-yet-chosen
  offerings — open query OR a by-id discovery initiator; MUST go through the shared predicate), `fulfilment` (by-id
  hydration of an already-held item; annotated `// discover-inventory: fulfilment`, NOT relationship/distribution-
  filtered, so a known/saved/in-flight product is never hidden from checkout), or `admin` (admin/back-office/
  supplier-portal and catalog-ingestion readers served to an admin/supplier surface, NOT a member Discover/ORB
  surface; annotated `// discover-inventory: admin`, unfiltered, admin-guarded). The distinguishing rule for `admin`
  is the surface it serves (admin/supplier, not member). `shop_videos`-only readers (e.g.
  `fetchRankedShopVideosPage`) are not `products`/`merchants` readers and are out of the inventory's scope.
- R4 WHEN a `products`/`merchants` reader is built, a PER-QUERY build-failing lineage guard SHALL fail if the SAME
  query that reads `products`/`merchants` also reads
  `health_*`/`wearable_*`/`biomarker_*`/`lab_*`/`vitana_index_*`; it SHALL NOT fail on an unrelated sibling function
  in the same file (the known mixed files are `health-wellness-repository.ts` and
  `health-action-initiative-repository.ts`).
- R5 WHEN a supplier onboards, the system SHALL offer a "which communities" step that creates `proposed`
  `supplier_tenant_relationships` rows, and a tenant SHALL be able to accept/decline (`proposed→active|declined`).
- R6 WHEN a signup carries `signup_intent='commerce'`, the system SHALL route it to the platform-tenant path only;
  `signup_intent` SHALL grant nothing (untrusted client metadata).
- R7 WHEN a purchase is attributed, the system SHALL record the buyer's active tenant; the recommender's earnings
  SHALL follow the recommender's tenant (D26); commission SHALL NOT influence ranking.
- R8 WHERE an offering is health-category (labs, practitioners), the system SHALL require trust level 2 + a signed DPA
  before listing it in any tenant.
- R9 WHEN a member opens Discover, the system SHALL present a scope control (Community/Network) separate from the
  Discover tab pill and from `MobileModePill`, defaulting to Community and remembered per surface.
- R10 WHILE the mt flags are off, Maxina Discover SHALL be unchanged (existing products `community`, active for
  Maxina only — D7).
- R11 The supplier "which communities" and tenant accept/decline UI SHALL follow the Commerce UX contract (AI-led,
  one dominant action, no internal concepts) and carry a "UX acceptance" section in the PR.

## Non-functional
- Dark by default (`MT_RESOLUTION_V2` + `tenant_settings.feature_flags.mt.discover_tenant_gate` / `mt.network_enabled`).
- Production read-only for every session and test (rules 31–32, 48); the executor never writes to a live system
  (collaboration §7a); DB applies are Kiro via RUN-MIGRATION, only on the owner's approval (§7d).
- i18n DE-first du-form, RTL (logical properties); Spotlight design contract; WCAG 2.2 AA.
- Test/service/platform-only accounts never surfaced (rules 43–45).
