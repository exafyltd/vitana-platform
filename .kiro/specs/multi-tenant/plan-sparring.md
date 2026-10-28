# Plan sparring record — multi-tenant M0 Kiro hand-off + next slice (tenant provisioning UI, AC-10 re-check)
change class: standard
scope: vitana-platform `.kiro/specs/multi-tenant/**` (requirements.md, design.md, tasks.md, handoff.md, lanes/*.md),
`docs/validation/<VTID>/**`; vitana-v1 `src/components/admin/tenant-provisioning/**`, `src/lib/tenant-provisioning-api.ts`
(+ test), `src/pages/admin/TenantManagement.tsx`, `src/i18n/{de,en}/tenantProvisioning.json`,
`tests/e2e/staging/vtid-XXXXX-*.staging.spec.ts`, `docs/validation/VTID-05221/**`, `docs/SCREEN_INVENTORY.md`,
`i18n-source-stamps/**`.
Evidence base: platform origin/main (2026-10-14, gateway prod = staging = 0b875e98), v1 origin/main (prod 49182e04,
staging c7a90a9c6). Read-only live checks 2026-10-14.

<!-- plan:begin -->
## Problem
1. The owner wants Kiro to continue the multi-tenant program (test of the VTID-05145 hand-off; roles VTID-05192:
   Claude plans/spars/reviews/merges/gates, Kiro implements lanes, never merges/deploys/allocates/writes live).
   Kiro only picks up work from `.kiro/specs/<slug>/` in git; no multi-tenant spec exists there
   (`.kiro/specs/` holds only `life-timeline`).
2. M0 lanes S-M/A/B/C are done and in production (VTID-05147/49/50/51: platform #4093 #4094 #4097 #4103 #4108,
   v1 #1369 #1382; 8 migrations applied via RUN-MIGRATION with clean post-checks; gateway staging-verified at
   f3bcf3dc3 91/91 and published 0b875e98; app published 49182e04 containing 6346af150 + 68ce4b398).
3. The owner's goal is "a new tenant to set up as quick as possible". Provisioning exists only as an API
   (`POST/GET/PATCH /api/v1/admin/tenants`, `PUT /:id/assets/:kind`, `GET /:id/readiness`, exafy_admin-only,
   `services/gateway/src/routes/admin-tenants.ts:76,127,317,388,473,536`) and a CLI (`scripts/tenants/**`). There is
   no screen: `src/pages/admin/TenantManagement.tsx` (v1, 241 lines, route `requiredRole="admin"`) only lists and
   switches tenants.
4. VTID-05149 AC-10 (24 h signup check: every new auth.users row has exactly one primary user_tenants row and a
   memberships row in the same tenant, `docs/validation/VTID-05149/acceptance.md:55`) is not yet recorded.

## Fix
1. **Spec (coordinator, `multi-tenant/_plan`)** in vitana-platform `.kiro/specs/multi-tenant/`:
   - `requirements.md` — program goal + this slice's requirements (EARS style), linking `docs/MULTI-TENANT-PLAN.md`,
     `docs/multitenancy/MIGRATION-QUEUE.md`, `docs/multitenancy/LANE-C.md`, `docs/validation/VTID-0514{7,9}/**`,
     `docs/validation/VTID-0515{0,1}/**` (no copies).
   - `design.md` — what exists (registry RPCs, provisioning API + payload schemas by file reference, brand pack,
     TenantPortal at `/:tenantSlug`), and the **successor rules**: migration queue order + lane version ranges and the
     MIGRATION-DRIFT-CHECK baseline workaround; every merged code change dark by default (`MT_RESOLUTION_V2`,
     `tenant_settings.feature_flags.mt.*`) unless the plan names an exception; 05147 AC-5 (no later migration re-grants
     member writes / recreates dropped policies / redefines `set_role_preference` without the membership check);
     Lane C whitelist contract (new keys = new migration + harness case); D12 (one session per VTID, ≤6 concurrent),
     D13 (no synthetic tenant in prod), D14 (auth hook applied by the owner only); production read-only; rule 43–45
     (test accounts invisible); i18n DE-first du-form; Spotlight contract; RTL.
   - `tasks.md` — task groups `<!-- lane: provisioning-ui -->` and `<!-- lane: ac10-recheck -->` with acceptance.
   - `handoff.md` — `slug: multi-tenant, author: claude, executor: kiro, next_actor: owner, state: sparred`, then
     `approved → executing` after Gate 1; log of what is done (Problem 2) and what is next.
   - `lanes/provisioning-ui.md` (`executor` kiro: `next_actor: kiro, state: ready`) and `lanes/ac10-recheck.md`
     (`next_actor: claude, state: ready`).
2. **Lane `provisioning-ui` (Kiro, vitana-v1)** — a "New community" panel added inline to `TenantManagement.tsx`,
   which renders at `/admin/system/tenants` (App.tsx:2157; `/admin/tenant-management` only redirects there, App.tsx:2221),
   rendered only when `useTenant().isExafyAdmin` (the API also enforces exafy_admin):
   - `src/lib/tenant-provisioning-api.ts`: typed JSON wrappers over `adminFetch` (`src/lib/admin-api.ts`) for list,
     provision, patch brand pack, readiness, plus a separate `uploadTenantAsset(id, kind, file)` that does its own
     authenticated `fetch` (same token + base URL logic as adminFetch) with `Content-Type` = the file's real MIME type and
     the raw file body — adminFetch forces `Content-Type: application/json` (admin-api.ts:38) and the route answers 415
     when declared and sniffed types differ (admin-tenants.ts:490). adminFetch sends only Authorization (its JSDoc claim
     about X-Vitana-* headers is wrong); the provisioning routes need nothing else; request types mirror
     `services/gateway/src/services/tenant-provisioning/schemas.ts` (`ProvisionTenantSchema`,
     `TenantBrandPackPatchSchema`, `ASSET_KINDS`); error codes (`RESERVED_SLUG`, `SLUG_TAKEN`, `INVALID_*`,
     `FORBIDDEN` = the 403 auth gate, `NOT_EXAFY_ADMIN` = the provision_tenant() DB check, 415) mapped to i18n keys.
   - `src/components/admin/tenant-provisioning/` — an explicit three-step flow: step 1 `ProvisionTenantForm` → POST
     with exactly the `ProvisionTenantSchema` fields (slug with client-side regex + reserved-slug check from
     `src/generated/reserved-tenant-slugs.json`, name, display name, admin email, all-members group name, default +
     enabled locales, timezone, currency, Jev monthly budget 0–500 USD optional); step 2 `BrandPackForm` → PATCH with
     `TenantBrandPackPatchSchema` fields (colours, legal entity line, support/sender name + email, landing cta, open
     sign-up toggle — default off; an optional collapsible "Persona facts" section for `persona_facts`: community name +
     pronunciation, anchor person, story/offer facts, tone; locale/timezone/currency/display name stay step-1 fields and are
     not repeated; `override_reason` only when the server asks for it); step 3 `AssetUpload` (logo/favicon/og_image; accepts only png/jpeg/webp, the
     server's `ALLOWED_ASSET_TYPES`, admin-tenants.ts:197); `ReadinessChecklist` (renders `GET /:id/readiness`).
     Composed in a `VCard`/Spotlight-compliant section; tokens only; logical start/end; skeletons.
   - Strings in `src/i18n/de/tenantProvisioning.json` first, mirrored to `en/`; no raw JSX text.
   - Nothing calls the API on load except list/readiness GETs; every write is an explicit admin button press.
   - Exception to dark-by-default (stated in design.md): the panel is exafy_admin-only and server-gated, no member
     can see it; dark would block the owner's goal. No new route → no nav-registry/manifest/parity change.
   - Tests (Vitest): API wrapper (URLs, bodies, error mapping), form validation (slug regex, reserved slug,
     email, colours), non-exafy admin does not see the panel, readiness rendering, no fetch on render except GETs.
   - Staging spec (read-only): signs in as the test user (not exafy_admin) → panel absent on
     `/admin/system/tenants`; `GET /api/v1/admin/tenants` with that user's token answers 403 JSON (gateway gate, not
     only UI); network guard proves no non-GET. `docs/validation/VTID-05221/staging-tests.json`,
     `scope.json` (PR gate), `plan-sparring.md` copy.
   - Kiro never runs the provisioning call against any live system; creating the real tenant stays an owner-approved
     step done by Claude after Gate 2.
3. **Lane `ac10-recheck` (Claude)** — read-only SQL on production: for auth.users created since A-M2 apply
   (2026-10-13, RUN-MIGRATION 38446340122), count rows lacking exactly one primary user_tenants row or a same-tenant
   memberships row; also exclude/flag rule-43 accounts. Record result in `docs/validation/VTID-05149/acceptance.md`
   (AC-10 line) via a PR. Non-zero → stop and report to the owner with ids redacted.
4. Allocation after Gate 1: two VTIDs (one per lane). The spec PR carries the provisioning-ui VTID in its title.
   Commits carry `Collab-Session: session_01TMPMNGNEtPxKwmVqyfdx46` and `Collab-Lane: multi-tenant/_plan` (or the lane).
5. After the spec merges: reply one line to coordinator session `session_01J2m8CtCfCH4VEGqmp6HrDh` that
   `multi-tenant/provisioning-ui` is `ready` on main.

## Migrations
None.

## Tests
- Spec PR: PR-GATE "Collab handoff" (`scripts/collab/queue.mjs validate`) green; `queue.mjs` shows the two lanes.
- provisioning-ui: Vitest above; ESLint i18n + design rules clean on new files; `npm test` (nav registry, design
  manifest unaffected); PR gate scope/sparring/weakening; full vitest.
- ac10-recheck: the SQL itself (read-only), output recorded.

## Staging verification
provisioning-ui: the read-only staging spec above (panel absent for a non-exafy admin; no non-GET requests). The
exafy_admin path is proven by Vitest only (no exafy test account on staging; staging writes to production Supabase).

## Rollout
Spec PR merged (docs only, no deploy, no Gate 2). provisioning-ui: Kiro PR → Claude review → merge → staging deploy →
STAGING-VERIFY → Gate 2 → PUBLISH. Then, on the owner's separate go with the tenant's details, Claude provisions the
new tenant through the API (the readiness checklist shows what is missing).

## Risks
- Kiro's first real lane: protocol friction (claims, trailers). Mitigation: explicit `paths`, explicit acceptance,
  Claude reviews before merge.
- An exafy-admin-only UI that writes to production when used. Mitigation: server-side exafy_admin gate, explicit
  buttons only, open sign-up off by default, readiness checklist before announcing a tenant.
- Payload drift between gateway zod schemas and v1 types. Mitigation: types reference the schema file; Vitest pins
  bodies; review checks against schemas.ts.

## Out of scope
- Remaining M0 items (WS0 lint/isolation suites in CI, WS1 auth hook shadow — D14, WS2 expand half, policy
  classification) → later slices in this spec, each sparred.
- Creating the real tenant row (owner-approved step after Gate 2).
- Custom domains, native app (WS9), Command Hub UI.

## Owner decisions
None new (D13 default No stands; the exafy-only exception to dark-by-default is stated for Gate 1).
<!-- plan:end -->

## Planner responses — round 1
- F1 [major] asset types → ACCEPTED: png/jpeg/webp only, referencing ALLOWED_ASSET_TYPES (admin-tenants.ts:197).
- F2 [major] adminFetch JSON-only → ACCEPTED: separate `uploadTenantAsset` with real MIME Content-Type and raw body; JSON wrappers keep adminFetch.
- F3 [minor] route is /admin/system/tenants → ACCEPTED: plan and staging spec now use /admin/system/tenants.
- F4 [minor] two-step flow + missing fields → ACCEPTED: explicit 3-step flow; display_name and jev budget added to step 1; step 2 lists the PATCH schema fields.
- F5 [minor] adminFetch headers JSDoc → ACCEPTED as a note in the plan (no reliance on X-Vitana-* headers); fixing the JSDoc is out of scope.
- F6 [minor] staging proves only absence → ACCEPTED: spec also asserts GET /api/v1/admin/tenants answers 403 JSON for the test user.
- F7 [minor] design ratchet → no change (already covered).
- Q1 → exposed (added). Q2 → separate upload function. Q3 → modify TenantManagement.tsx inline (panel component imported there).

## Partner — round 2
F1–F7 closed. New: F8 [minor] step 2 omits persona_facts; F9 [minor] auth gate code is FORBIDDEN, NOT_EXAFY_ADMIN is the DB code. Verdict: CONVERGED.

## Planner responses — round 2
- F8 → ACCEPTED: optional "Persona facts" section in step 2; overlap fields stay in step 1.
- F9 → ACCEPTED: both codes mapped, each named with its layer.

## Verdict and approval
- Sparring session: `plan_sparring_sessions` id `6400562e-544a-4a67-b191-bdc63a6e3495`, change class standard,
  2 rounds, verdict **converged**.
- Plan hash (sha256 of the text between the plan markers, before VTID substitution):
  `ee56b2172f617c17dae6a39151f7f44fb5358f66f80ed572aebfc6d2b17794b1`.
- **Owner approval:** "yes" at Gate 1 in Claude Code session `session_01TMPMNGNEtPxKwmVqyfdx46`, 2026-10-15
  (recorded as `human_approved_at` on the sparring session).
- VTIDs: VTID-05221 (lane provisioning-ui), VTID-05222 (lane ac10-recheck).

## Post-approval implementation note (2026-10-15)
Codex review on the spec PR: the queue derives a lane's executor from `handoff.md` (`executor: kiro`), so a Claude lane
inside this spec would never be picked up. The AC-10 re-check (VTID-05222) is therefore run by the coordinator directly,
not as a queue lane. Same work, same VTID, no scope change; the approved plan text above is unchanged.
