# Internal adversarial review — mt-launch (WS8 Tenant Launch engineering)

Reviewer: independent internal reviewer (fresh context), session for spec NN=11 `mt-launch`.
Date: 2026-10-15. Scope: `plan.md`, `requirements.md`, `design.md`, `tasks.md`, `handoff.md`, `lanes/*.md`.
Method: read-only verification against current platform code (`file:line`), the BATCH-BRIEF "Internal review"
criteria, the CROSS-SPEC-DECISIONS rulings naming mt-launch, and the `queue.mjs` validators. No spec edits, no git,
no suites re-run.

## Verdict
**APPROVED.** Zero HIGH and zero MEDIUM findings. Three NITs below (non-blocking). The "## Open questions for sparring"
items in `plan.md` are non-blocking by the brief.

## What was verified against the real code (all confirmed)

1. **PACK_FIELDS** — `services/gateway/src/routes/admin-tenants.ts:383` (`const PACK_FIELDS = [`). Plan cites `:384`;
   off by one, immaterial. Readiness `GET /:id/readiness` at `:536`, assets `PUT /:id/assets/:kind` at `:471-473`,
   `computeReadiness` import at `:35`. All match the plan's premise #1 and design "What exists".
2. **`isFeatureLive` is single-arg / global** — `services/gateway/src/services/feature-flags.ts:81`
   `export function isFeatureLive(name: string): boolean`. Confirms the plan's HIGH-1 round-1 correction: it cannot
   express a per-tenant flag; a new `isTenantFeatureLive(tenantId, key)` resolver is correctly required.
3. **`MT_RESOLUTION_V2` does not exist** — case-sensitive scan of `services/gateway/src/**/*.ts` = 0 matches. Confirms
   the plan's MEDIUM-1 round-1 correction and design rule 2 / Rollout: it is mt-identity's (WS1) switch to introduce,
   listed only as an operational dependency, and the `mt.launch_*` flags are independently default-OFF.
4. **Per-tenant flag pattern to copy exists** — `services/gateway/src/services/data-export-consent.ts` (matches at
   `:19,:79,:83,:92,:93,:96,:121`, incl. `=== true` / `feature_flags`) and
   `data-export-consent-repository.ts`. The resolver design (strict `=== true`, default OFF, error ⇒ off, 5-min cache,
   own repo seam) is a faithful copy. Correct.
5. **Analytics base exists** — `supabase/migrations/20260612140000_BOOTSTRAP_product_analytics_events.sql` present;
   `services/gateway/src/routes/tenant-admin/product-analytics.ts` present (the existing admin read the owner surface
   is distinct from). Premise #3 holds.
6. **Health lineage guard pattern to copy exists** — `services/gateway/test/vtid-05025-commerce-health-boundary.test.ts`
   and `test/vtid-05156-people-match-health-boundary.test.ts` both present. The D18 guard copies a real pattern.
7. **Support + referral premises** — `routes/feedback-admin.ts` (`GET /tenants/:tenantId/tickets` at `:221`, confirmed
   by the comment block), `routes/feedback-intake.ts`, `routes/community-invites.ts`, `routes/admin-signups.ts`,
   `services/community-autopilot/drafts.ts`, `services/anthropic-vision-client.ts` all present. Premises #4, #5 hold.
8. **New targets correctly absent** — `routes/landing-seo.ts`, `routes/tenant-admin/owner-analytics.ts`,
   `routes/tenant-admin/pack-intake.ts` do NOT exist yet (new files), and `tenant_content_overrides` has 0 references
   in `supabase/migrations/**` (confirms premise #2 and the cross-spec dependency on mt-packs for WS5's table).
9. **Migration range free** — no `2026110111*` migration exists; `scripts/ci/migration-drift-baseline.json` and
   `docs/multitenancy/MIGRATION-QUEUE.md` exist (both in pack-intake-db paths). Range `110000`–`115959` (NN=11) is
   valid and collision-free.

## Validators (queue.mjs parseFrontMatter / validatePlan / validateLane)
Ran the exported validators against `handoff.md` and all five lane files:

```
handoff.md: OK
lanes/pack-intake-admin.md: OK
lanes/pack-intake-db.md: OK
lanes/support-landing.md: OK
lanes/tenant-owner-analytics.md: OK
lanes/worker-test-gate.md: OK
```

Zero validator errors. Front matter is well-formed everywhere; `reviewer_seat` (`exafy`, and `jtadic` for the Claude
lane) differs from each lane's own `seat`; `executor` values are valid; `depends_on` only names lanes within the spec;
no Kiro-executor lane declares a governance path.

## Cross-spec rulings naming mt-launch (CROSS-SPEC-DECISIONS.md) — all confirmed applied
- **O1 (health table list = mt-identity `isHealthTable()`).** Applied: plan #3, R3.2, design rule 3, tasks P2,
  `tenant-owner-analytics.md` body all state the D18 guard references mt-identity's canonical `isHealthTable()` and
  keeps no own list. ✓
- **O3 (What's New / drafter golden stays mt-packs + mt-guardrails `v1-golden-edge`).** Applied: this spec publishes
  INTO `tenant_content_overrides` only, states the golden suite is unchanged here, and defers any drafter-prompt change
  to mt-packs (Depends on, Out of scope). ✓
- **platform_only_accounts (O5), network groups, moderation (O4), lane-count merge rule.** None of these are owned by
  mt-launch; the spec correctly does not touch them. Lane count is 5 (4 code/DB + 1 governance), within target. ✓

## Brief-specific requirements — all confirmed
- **Engineering-ONLY scope.** Non-engineering ops (anchor-person consent, Season 0 approval, Exafy sign-off, revenue
  share, founding-invite send, opening the tenant) are explicitly under "Out of scope" and "Owner decisions" and are
  tracked as `tenant_pack_intake` items, not code. ✓
- **Tenant-owner analytics never include health data; D18 lineage lint; unknown-provenance = health.** Present in
  plan #3, R3.2, design rule 3, tasks P2 as a build-failing fail-closed source-scan with an explicit read allowlist
  (unknown table = fail). ✓
- **worker-test-gate is executor claude (governance `.github/workflows`).** `lanes/worker-test-gate.md` front matter:
  `executor: claude`, `next_actor: claude`, paths only `.github/workflows/*`, reviewer_seat `jtadic`. ✓
- **DB/code split (§4.7).** `pack-intake-db` (migrations + pgTAP) is separate from the three code lanes; governance
  lane separate. ✓
- **Dark by default.** Every code lane gated by its own default-OFF per-tenant flag via `isTenantFeatureLive`. ✓
- **tasks.md "Allowed paths" == lane `paths`.** Byte-compared for all five lanes — identical. ✓
- **Migration safety.** Expand-only, no backfill, service-role-only RLS, SECURITY DEFINER read-only function with no
  health table, rollback SQL, pre/post `to_regclass` checks, MIGRATION-QUEUE row ordered after WS5's
  `tenant_content_overrides`, drift baseline entry removed after apply, renumber-if-later note. Applied by Claude via
  RUN-MIGRATION — Kiro writes a migration file only. ✓
- **Standing rules.** Production read-only (31/31b/48), staging read-only with non-GET network guard, executor never
  writes to a live system (§7a), rule 41 (pipeline publishes UI/catalog strings not spoken lines), 42c
  (`npm run test:support` stays green), i18n/Spotlight noted. ✓

## No duplication of DONE work or another spec
`tenant_content_overrides` creation stays in mt-packs; `isHealthTable()` stays in mt-identity; the existing
`product-analytics.ts` admin read is not re-owned (owner analytics is a distinct new surface); invitation/moderation
work (mt-tenant-admin) is untouched. No overlap with VTID-0514{9} / VTID-0515{0,1} done work beyond building on them.

## Findings

### NIT-1 — `docs/validation/VTID-mt-launch-*/**` listed in lane `paths` deviates from the brief's "omit docs/validation"
`lanes/pack-intake-admin.md`, `tenant-owner-analytics.md`, `support-landing.md` each list a placeholder
`docs/validation/VTID-mt-launch-<lane>/**` entry in `paths`. The BATCH-BRIEF says to "omit docs/validation and note in
body the lane adds its own docs/validation/<vtid>/". This is non-blocking because (a) the `queue.mjs` scope-check
`own()` predicate (`queue.mjs:464`) already auto-allows `docs/validation/<fm.vtid>/` once the real VTID is in front
matter, so the placeholder glob is redundant rather than harmful, and (b) it is applied uniformly across all 14 sibling
specs (planner-wide convention), not an mt-launch defect. Fix (optional): drop the `docs/validation/...` path line and
rely on the body note + scope-check auto-allow, OR keep it as a harmless over-declaration.

### NIT-2 — `services/gateway/src/index.ts` is declared by two lanes
`pack-intake-admin` and `tenant-owner-analytics` both list `services/gateway/src/index.ts` (each mounts its own
router). This is a shared-file touch across lanes. Non-blocking because `tenant-owner-analytics` `depends_on`
`pack-intake-admin`, so they merge sequentially and each adds only its own mount line; the Lane scope check permits a
lane to change files it declares. Fix (optional): note in both lane bodies that each appends only its single
`.mount()`/router-registration line to `index.ts` to minimise conflict, or route the mounts through a per-lane
sub-index. Either is cosmetic.

### NIT-3 — PACK_FIELDS line citation off by one
Plan premise #1 and handoff cite `admin-tenants.ts:384`; the array declaration is at `:383`. Immaterial; the field
list and surrounding readiness refs are correct. Fix (optional): change `:384` → `:383`.

## Open questions for sparring (non-blocking, already in plan.md)
- Final `item_key` enum vs the WS4 provisioning readiness list (mt-tenant-admin owns `provision_tenant`/readiness).
- Whether the D18 analytics non-health allowlist should live beside mt-identity's `isHealthTable()` as a shared
  non-health allowlist.

Both are legitimately cross-spec and correctly parked under "Open questions for sparring"; neither blocks.
