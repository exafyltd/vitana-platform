---
change_class: standard
---
# plan(mt-m3): M3 generally-provisionable — custom domains, tenant switching UI, monitoring, ERP bootstrap, offboarding runbook

<!-- plan:begin -->
## Problem
Program `docs/MULTI-TENANT-PLAN.md` v5.1 §6 "Deferred to M3" + §7 milestone **M3** ("deferred items per decisions;
wizard polish; offboarding runbook; per-tenant monitoring") and the native custom-domain note §4.8. Verified against
platform/v1 `origin/main` today (file:line below). Predecessors M0 S-M/A/B/C are live
(VTID-05147/05149/05150/05151, `docs/multitenancy/MIGRATION-QUEUE.md`).

1. **No host-based tenant resolution exists.** The program's resolution chain starts `host (tenant_domains.host) → …`
   (§4.1) but there is no `tenant_domains` table (0 hits across `supabase/migrations/**`, verified today) and no host
   arm in the gateway: `services/gateway/src/middleware/auth-supabase-jwt.ts` resolves tenant only from the JWT
   `app_metadata.active_tenant_id` claim (`:283`) with a `user_tenants` fallback; no `req.hostname`/`DOMAIN_TENANT_MAP`
   reader is wired (grep: hostname is used only for CORS/affiliate URL parsing, never tenant resolution). `resolve_tenant`
   (VTID-05151) takes a slug only.
2. **No member-facing tenant switching UI (D8: "switching UI in M3").** `src/hooks/useTenant.tsx` has
   `setTenantBySlug()` (calls the `switch_to_tenant_by_slug` RPC + `refreshSession()`, `:148,207`), and
   `src/pages/admin/TenantManagement.tsx` switches as an **exafy-admin** action gated by `canSwitchTenant` =
   `exafy.admin` + `tenant.switch` (`src/lib/permissions.ts:24`). A normal dual member has no UI to switch between their
   own communities. The portal join flow (`src/pages/portals/TenantPortal.tsx:190`) is a different thing (joining, not
   switching an existing membership).
3. **Custom domains are not deliverable natively.** AASA ships one appID `62Q26QSEJW.com.exafy.maxina` with `paths:["*"]`
   (`vitana-v1/public/.well-known/apple-app-site-association`) and one `assetlinks.json`; §4.8/D5 say a custom domain
   needs associated-domain entitlements compiled into the binary (an app release per domain), and the single
   AASA/assetlinks set covers every tenant only while they live under `vitanaland.com/<slug>`.
4. **`provision_tenant()` records no ERP bootstrap.** `supabase/migrations/20261014000500_vtid_05150_provision_tenant.sql`
   writes the tenant row, `tenant_settings` (locales/timezone/currency/Jev budget), groups, bot, founding row, invitation —
   but §4.6's "ERP bootstrap request" line is not implemented (grep `erp`/`bootstrap` in that file = none). BackOffice ERP
   is per-tenant already (§2) but a new tenant is not auto-enrolled.
5. **Monitoring is Maxina-era, not per-tenant.** `ci_tenant_isolation_health()` exists
   (`supabase/migrations/20261014000300_vtid_05149_ci_tenant_isolation_health.sql`) and is wired report-only into
   `.github/workflows/MORNING-SYSTEM-HEALTH-CHECK.yml`. It returns global counts; there is no per-tenant breakdown or
   per-tenant alert so an operator can see which tenant drifted.
6. **Price/currency are provisioned once, never per-tenant overridable (D2/D9).** `provision_tenant` writes a single
   `tenant_settings.currency` (`:155`) and the Jev budget is the only money knob; D2 permits *de-hardcoding* a per-tenant
   price-display currency/override surface **only as far as D2/D9 allow** (one shared VTNA wallet, shared plans/prices,
   no invoicing). This slice does the de-hardcoding read path only, no per-tenant economy.
7. **No offboarding runbook.** Deactivate/archive is **owned by mt-tenant-admin** (cross-spec O2: lane
   `tenant-lifecycle-db` + `tenant-admin-api`, verified in `.kiro/specs/mt-tenant-admin/tasks.md`). mt-m3 must not
   re-plan it; it only needs the operator-facing offboarding/archive **runbook** that references those RPCs.

Network groups (D27) are owned by mt-network and are explicitly **not** planned here (CROSS-SPEC "Network groups").

## Fix
Dark by default via `MT_RESOLUTION_V2` + `tenant_settings.feature_flags.mt.*` unless named (§4.7, §8). Lanes:

1. **`tenant-domains-db` (DB, vitana-platform).** New `tenant_domains(tenant_id fk, host citext unique, is_primary,
   verified_at, created_at)` with RLS (service-role/ exafy-admin only; no client writes), FK to `tenants`, host format
   check; extend `resolve_tenant(host, slug)` to resolve a host ONLY when its row has `verified_at IS NOT NULL` and ONLY
   through `_tenant_public_registry()` (which already filters `is_active AND is_platform = false`, verified
   `20261014000600_…:74-77`), else slug — an unverified/inactive/platform host resolves empty and falls through. The host
   arm must not widen the returned field set (Lane C whitelist). A host must not collide with a reserved slug. Migrations
   in range 20261101140000–; rollback + read-only pre/post
   checks; MIGRATION-QUEUE rows appended after the mt-tenant-admin block. Expand-only.
2. **`host-resolution-gw` (gateway code).** Add a host arm to `TenantContext` resolution
   (`services/gateway/src/services/tenancy/tenant-context.ts` + the middleware read in `auth-supabase-jwt.ts`): resolve
   `req.hostname` through `resolve_tenant(host,…)` BEFORE the slug/claim arms, membership still required for data
   (host tenant ≠ member → the existing "join" posture, never a silent default). Dark behind `MT_RESOLUTION_V2`.
   Depends on `tenant-domains-db`.
3. **`tenant-switcher-ui` (vitana-v1, frontend).** A member-facing community switcher for members of ≥2 tenants:
   list the member's own memberships from `useMemberships()` (`list_my_memberships`, not the public registry — the
   registry only resolves each membership's slug/brand for display), call the existing
   `setTenantBySlug()`; no new switch mechanism (reuse `switch_to_tenant_by_slug` + `refreshSession`). Hidden for
   single-tenant members. Not exafy-admin-gated (that is `TenantManagement`); gated on "member of >1 tenant". Spotlight
   tokens, logical start/end, i18n DE-first du-form, RTL. New surface mounted in Settings (no new route → no nav
   registry/manifest/parity change; if a route is added, the registry+manifest+parity rows are added in the same lane).
4. **`native-domains-aasa` (vitana-v1, native).** Make AASA/assetlinks custom-domain-ready: keep the single
   `vitanaland.com` set for path-slug tenants; document and template the per-domain release requirement (§4.8) —
   a `tenant_domains.host` with `verified_at` that needs native reach requires an app release whose entitlements list
   that domain. Add a generation note + a test that the committed AASA/assetlinks stay valid and that adding a custom
   domain does not silently assume universal-link coverage. No store submission here (that is a governed native release).
5. **`provision-erp-monitoring-db` (DB, vitana-platform).** (a) Extend `provision_tenant()` to record the §4.6 ERP
   bootstrap request (idempotent, additive — a `tenant_settings.feature_flags`/bootstrap-request row the BackOffice ERP
   job consumes); (b) add `ci_tenant_isolation_health_by_tenant()` returning the existing counts grouped per tenant.
   Expand/contract, rollback, pre/post checks, QUEUE rows. Keeps `ci_tenant_isolation_health()` unchanged (reused, not
   rebuilt).
6. **`monitoring-erp-gw` (gateway code).** Surface the per-tenant isolation counts on the existing admin health read and
   wire the ERP bootstrap-request consumer into the BackOffice ERP path; dark behind the flag. Depends on
   `provision-erp-monitoring-db`.
7. **`morning-health-pertenant` (governance, executor: claude).** One edit to
   `.github/workflows/MORNING-SYSTEM-HEALTH-CHECK.yml` to also report the per-tenant breakdown (report-only, read-only).
   `.github/**` is a governance path (collaboration §3a / queue.mjs `GOVERNANCE_PATHS`), so this lane is `executor:
   claude`. Depends on `provision-erp-monitoring-db`.
8. **`wizard-price-polish` (vitana-v1, frontend).** Provisioning-wizard polish on top of VTID-05221's panel (readiness
   affordances, custom-domain field feeding `tenant_domains`, clearer step errors) AND the D2/D9-bounded price/currency
   **display** de-hardcoding (read a tenant's `tenant_settings.currency` for price rendering instead of a hardcoded
   constant; NO per-tenant pricing, wallet or invoicing). Offboarding/archive **runbook** doc
   (`docs/multitenancy/RUNBOOK-offboarding.md`) referencing mt-tenant-admin's O2 RPCs — reference only, no RPC defined
   here. i18n DE-first du-form, Spotlight, RTL.

## Migrations
Range **20261101140000–20261101145959** (free; grep `20261101` across `supabase/migrations/**` = 0 today). Files:
- `20261101140000_vtid_*_mt_tenant_domains.sql` (+ `..._rollback.sql`) — lane `tenant-domains-db`.
- `20261101140100_vtid_*_mt_resolve_tenant_host.sql` (+ rollback) — lane `tenant-domains-db` (extends `resolve_tenant`).
- `20261101141000_vtid_*_mt_provision_erp_request.sql` (+ rollback) — lane `provision-erp-monitoring-db`.
- `20261101141100_vtid_*_mt_isolation_health_by_tenant.sql` (+ rollback) — lane `provision-erp-monitoring-db`.
MIGRATION-QUEUE position: after mt-tenant-admin's `070600` block and after every mt-* 0701xx reservation; each lane's
PR appends its own rows with depends-on and rollback paths. Each file ships a read-only pre-check and post-check SQL for
Claude's RUN-MIGRATION; `migration-drift-baseline.json` carries any not-yet-live table (`tenant_domains`) and the PR
removes it after apply. Expand/contract; `lock_timeout` + retries. DB applied by Claude via RUN-MIGRATION after merge.

## Tests
- pgTAP (DB lanes): `tenant_domains` RLS (b_member/anon cannot read or write; exafy-admin/service only); `resolve_tenant`
  resolves a VERIFIED host, falls back to slug, rejects a host colliding with a reserved slug, and resolves EMPTY for an
  unverified host (`verified_at IS NULL`) and for a host on an inactive/platform tenant (so the host arm cannot set a
  cross-posture context); the returned column set is pinned (no `tenant_domains` column). `provision_tenant` records
  the ERP request idempotently and still passes its existing assertions; `ci_tenant_isolation_health_by_tenant()` sums to
  `ci_tenant_isolation_health()`.
- Jest/Vitest (gateway): host arm resolves before slug/claim and never grants data without membership (contract test:
  host tenant ≠ member → join posture); per-tenant health counts shape; ERP consumer idempotent. `npm run test:support`
  + `npm run test:operator` stay green (42c/42e) if touched.
- Vitest (v1): switcher lists only the member's memberships, hidden for single-tenant members, calls `setTenantBySlug`;
  AASA/assetlinks validity + custom-domain universal-link guard; price render reads tenant currency; wizard custom-domain
  field posts to `tenant_domains`. ESLint i18n + design clean on new files; `npm test` (nav registry/design manifest).
- Golden: Maxina surfaces byte-identical where touched (rule 41 — spoken output not compared).

## Staging verification
Read-only (rule 48). v1 staging specs sign in as the test user and assert: the switcher is absent for a single-tenant
member; `/admin/system/tenants` host/domain field renders; a network guard aborts every non-GET. Gateway host-arm and
per-tenant health proven by Jest only (no custom domain or multi-tenant member on staging; staging uses production
Supabase). No suite targets production.

## Rollout
Dark by default (`MT_RESOLUTION_V2` + `tenant_settings.feature_flags.mt.*`). DB applied by Claude via RUN-MIGRATION in
MIGRATION-QUEUE order after merge. **Owner-only:** actually pointing a custom domain / shipping a per-domain native
release is a governed native release + DNS step, named here, not done by a lane. Deactivate/archive execution stays with
mt-tenant-admin; this spec adds only the runbook.

## Risks
- Host resolution opening a cross-tenant path if membership is not re-checked. Mitigation: host sets context only; data
  still requires `is_member`; contract test on host tenant ≠ member.
- `resolve_tenant` signature change breaking VTID-05151 callers. Mitigation: additive overload / optional host arg;
  existing slug behaviour pinned by a test.
- Custom-domain expectation outrunning native reality (needs an app release). Mitigation: runbook + guard test make the
  per-domain release explicit; no silent universal-link claim.
- Price de-hardcoding drifting into a per-tenant economy. Mitigation: display-only, D2/D9 fenced, review checks no wallet/
  plan/invoice change.

## Out of scope
- Deactivate/archive implementation (mt-tenant-admin, O2) — runbook reference only.
- Network groups (mt-network) and any Network-scope work.
- Per-tenant money beyond currency-display de-hardcoding: wallet, plans, Stripe accounts, tax, invoices, coupons (M3+ /
  D2/D9).
- Per-tenant navigation, per-tenant voice persona, white-label app builds, actual store submission.

## Depends on
- Specs: **mt-tenant-admin** (O2 — `deactivate_tenant`/`archive_tenant` + closing switch RPC; referenced by the runbook,
  not redefined). **mt-identity** (`tenant_id_for_policies()`/`is_member()`, `TenantContext`) for the host arm's
  membership check. **mt-frontend-brand** (CORS allowlist already reads `tenant_domains` hosts — this spec creates that
  table; recorded, not a `depends_on` front-matter entry since it is a different spec).
- Done: VTID-05147 (S-M), VTID-05149 (A: `is_default`/`is_platform`, `TenantContext`, `ci_tenant_isolation_health()`),
  VTID-05150 (B: `provision_tenant`, admin-tenants API), VTID-05151 (C: `resolve_tenant`, public registry, `useTenant`).
- Within this spec: `host-resolution-gw` depends on `tenant-domains-db`; `monitoring-erp-gw` and
  `morning-health-pertenant` depend on `provision-erp-monitoring-db`; `wizard-price-polish` depends on
  `tenant-domains-db` (custom-domain field).

## Owner decisions
D5 (custom domains later, per-domain app release), D8 (switching UI in M3), D2/D9 (one wallet, shared prices, no
invoicing — price work is display de-hardcoding only) are DECIDED; applied, not re-argued. No new owner decision; custom
domain go-live and native release remain owner-gated steps named under Rollout.
<!-- plan:end -->

## Open questions for sparring
- Does `resolve_tenant` get an optional `host` argument (additive) or a sibling `resolve_tenant_by_host`? Proposed:
  additive optional arg so VTID-05151's slug callers are untouched (pinned by a test). Cross-spec with mt-frontend-brand,
  which already assumes `tenant_domains` hosts feed the CORS allowlist.
- ERP bootstrap request shape: a `tenant_settings.feature_flags.erp.bootstrap_requested` flag vs a dedicated
  `tenant_bootstrap_requests` row. Proposed: the flag (smaller, no new table), BackOffice ERP job reads it; revisit if a
  per-request audit trail is needed.
