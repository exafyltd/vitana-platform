---
slug: mt-launch
author: kiro
author_seat: hotmail
executor: kiro
next_actor: claude
state: drafted
updated: 2026-10-17T14:26Z
---
# Handoff — mt-launch (WS8 Tenant Launch engineering)

Planner: Kiro seat `hotmail` (session `kiro-hotmail-202610151618-b437`). This spec covers MULTI-TENANT-PLAN.md §6 **WS8
engineering only**: tenant pack intake data model + admin, the AI-assisted content pipeline (health-claim /
leftover-brand / undated-claim linters, review + sign-off, publish to `tenant_content_overrides`), tenant-owner
analytics (signups, activation, journey, events, retention — never health data, D18 fail-closed lineage lint), per-tenant
support routing, and landing SEO/OG + referral-invite attribution. Non-engineering launch steps (anchor-person consent,
Season 0 approval, Exafy sign-off, revenue share, founding-invite send, opening the tenant) are owner/ops actions tracked
as `tenant_pack_intake` items, not code.

Plan: `plan.md` (between the plan markers). Requirements/design/rules for successors: `requirements.md`, `design.md`.
Tasks: `tasks.md`. Lanes are **held** (`next_actor: owner`) until PLAN-SPAR converges and allocates each lane's VTID —
PLAN-SPAR flips a lane to `next_actor: kiro` itself. The governance lane `worker-test-gate` is `executor: claude`.

Lanes:
- `pack-intake-db` — DB (migrations), seat `hotmail`, reviewer `exafy`, repo vitana-platform, `ready` (held).
- `pack-intake-admin` — gateway code, seat `jtadic`, reviewer `exafy`, repo vitana-platform, `ready` (held);
  depends_on `pack-intake-db`. Creates the shared per-tenant dark-flag resolver `tenant-feature-flag.ts`.
- `tenant-owner-analytics` — gateway code, seat `jtadic`, reviewer `exafy`, repo vitana-platform, `ready` (held);
  depends_on `pack-intake-db`, `pack-intake-admin` (imports the resolver read-only).
- `support-landing` — gateway code, seat `jtadic`, reviewer `exafy`, repo vitana-platform, `ready` (held);
  depends_on `pack-intake-admin` (imports the resolver read-only).
- `worker-test-gate` — governance (`.github/workflows`), executor `claude`, reviewer `jtadic`, `ready`;
  depends_on `pack-intake-admin`, `tenant-owner-analytics`.

Cross-spec dependencies (CROSS-SPEC-DECISIONS.md): publishes INTO `mt-packs`'s `tenant_content_overrides` (O3 drafter
golden stays mt-packs/mt-guardrails); the D18 lineage lint references `mt-identity`'s canonical `isHealthTable()` (O1),
never its own list; suites plug into `mt-guardrails` WS0 harness. depends_on in each lane lists only lanes in THIS spec.

## Log
### 2026-10-15T16:40Z · kiro-hotmail-202610151618-b437 · created → drafted
Authored the WS8-engineering spec and pushed it as a `plan(mt-launch): …` PR (push-first, before internal review).
Premises verified read-only in platform code today: PACK_FIELDS (`admin-tenants.ts:384`); no `tenant_content_overrides`
(0 in `supabase/migrations/**`); `product_analytics_events` + rollups + `tenant-admin/product-analytics.ts`; the health
lineage guard pattern (`test/vtid-05025-commerce-health-boundary.test.ts`, `vtid-05156-…`); `feedback_tickets` +
`feedback-admin.ts:221`; referral/invite attribution already tenant-scoped (`community-invites.ts:78`,
`admin-signups.ts:208-229`). Migration range `20261101110000`–`115959` (NN=11). Lanes held until PLAN-SPAR converges and
allocates VTIDs. Next: PLAN-SPAR spars this PR; a Kiro seat then builds each lane after its VTID lands.

### 2026-10-15T17:10Z · kiro-hotmail-202610151618-b437 · internal review round 1 — fixed 1 HIGH + 1 MEDIUM, re-pushed
Addressed both internal-review findings (verified read-only in platform code first):
- **HIGH-1 (dark-flag API):** the plan cited `isFeatureLive('mt.launch_*', tenantId)` / "reuse `services/feature-flags.ts`".
  Verified `feature-flags.ts:81` exports `isFeatureLive(name: string): boolean` — single-arg, GLOBAL `FEATURE_<NAME>_ENV`,
  no per-tenant resolution. Replaced with a new per-tenant resolver `services/tenant-launch/tenant-feature-flag.ts`
  (`isTenantFeatureLive(tenantId, key)`) modelled on `services/data-export-consent.ts:79-108` +
  `data-export-consent-repository.ts:25` (reads `tenant_settings.feature_flags.<key>` strictly `=== true`, default OFF,
  error ⇒ off, 5-min cache). `pack-intake-admin` creates the resolver + its repo seam (added both files to that lane's
  `paths`/tasks P2 + a resolver unit test); `tenant-owner-analytics` and `support-landing` import it read-only and now
  `depends_on: pack-intake-admin` (no path entry — importing doesn't change the file, so Lane scope holds). Updated
  plan.md Fix, design.md pack-intake-admin/analytics/support sections + What-exists list, tasks.md P1/P2/P5, all three
  code lane files.
- **MEDIUM-1 (`MT_RESOLUTION_V2`):** verified case-sensitive grep of `services/gateway/**/*.ts` = 0 matches. It is NOT an
  existing master gate. Reworded plan.md Rollout + design.md rule 2 + What-exists list to state it does not exist yet, is
  mt-identity's (WS1) to introduce, and that each `mt.launch_*` per-tenant flag is independently default-OFF so the lanes
  are dark-safe without it. Added mt-identity's `MT_RESOLUTION_V2` to `## Depends on` as an operational dependency.
Validators re-run on `handoff.md` + all five lanes (0 errors). tasks.md Allowed paths == lane `paths` for every lane.
No product-behaviour change (same dark-by-default intent, correct per-tenant mechanism). Deleted INTERNAL-REVIEW.json.

### 2026-10-17T14:26Z · ci-plan-spar · escalated (partner unavailable)
The sparring partner could not review (code_access_unavailable). Not a plan problem: Claude Code looks at the partner, then re-runs.
