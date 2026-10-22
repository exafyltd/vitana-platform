---
slug: mt-launch
author: kiro
author_seat: hotmail
executor: kiro
next_actor: kiro
state: approved
updated: 2026-10-21T13:58Z
sparring_record: .kiro/specs/mt-launch/sparring/verdict.md
vtids: [VTID-05323, VTID-05324, VTID-05325, VTID-05326, VTID-05327]
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

### 2026-10-17T15:33Z · ci-plan-spar · escalated (partner unavailable)
The sparring partner could not review (model_unavailable). Not a plan problem: Claude Code looks at the partner, then re-runs.
### 2026-10-18T19:15Z · kiro-hotmail-202610151618-b437 · re-plan after PLAN-SPAR escalation (evidence_floor_not_met) — re-verified premises, fixed file:line drift, re-pushed
PLAN-SPAR round 1 escalated with `evidence_floor_not_met` (partner needs premise checks citing read results); the two prior escalations were partner infra (code_access_unavailable / model_unavailable), not plan problems. Re-verified the load-bearing premises read-only against the branch tip and corrected three drifted file:line refs in `plan.md` (no behaviour change): PACK_FIELDS `admin-tenants.ts:384` — `:383`; tenant-scoped tickets read `feedback-admin.ts:221` — `:231`; referral payload `community-invites.ts:78` — `:79`. Confirmed unchanged/correct: readiness `admin-tenants.ts:536`; `isFeatureLive(name: string): boolean` single-arg global at `feature-flags.ts:81`; the resolver model `data-export-consent.ts:79`/`:92-93`; `product_analytics_events` migration `20260612140000`; D18 guard pattern tests `vtid-05025`/`vtid-05156`. Validators re-run (0 errors). Re-pushed so PLAN-SPAR re-spars the refreshed plan.
### 2026-10-18T19:20Z · kiro-hotmail-202610151618-b437 · answered sparring s2 round 1 (5 findings) — all accepted, plan.md fixed, re-pushed
Session `3857a677` round 1 produced 5 findings (1 blocker, 2 major, 2 minor); evidence floor met. Verified every premise read-only against the pinned commit and accepted all 5 (`sparring/s2-responses-1.md`):
- **R1-F1 (blocker, accepted):** `admin-signups.ts:205` dispatches signup/referral/shared_link events against hardcoded `process.env.DEFAULT_TENANT_ID` — the plan's 'already tenant-scoped' claim was false. `support-landing` now owns per-tenant referral attribution (resolve real tenant before dispatch), dark behind `mt.launch_support`, with a non-default-tenant Jest test + a Risk. Problem #5 rewritten.
- **R1-F2 (major, accepted):** `live-tool-catalog.ts` is the ORB-live persona-switch tool (`orb/live/tools/`), not the ticket router; specialist detection is `feedback-intake.ts:32-37` (`KIND_BY_AGENT`). Change sites were right; Problem #4 citation corrected.
- **R1-F3 (major, accepted):** `isHealthTable()` does not exist in the gateway yet and `vtid-05025` defines `HEALTH_TABLES` inline. Resolved the self-contradiction to Option A: the D18 test ships an inline regex now (unblocked), migrating to mt-identity's canonical predicate as a tracked follow-up. Tests + Depends-on now agree.
- **R1-F4 (minor, accepted):** added explicit VTID merge-order guard — `support-landing` merges only after `pack-intake-admin` closes; lanes not merged (DB/code split, §4.7).
- **R1-F5 (minor, accepted):** `community-invites.ts:79` is only an OASIS event payload; removed as attribution evidence, /claim path (:54-82) is tenant-agnostic.
Validators re-run on handoff.md + all five lanes (0 errors); tasks.md markers 1:1, Allowed paths == lane paths. Plan body ~15.8k chars, markers + change_class intact. Re-pushed to start the next round.

### 2026-10-18T20:01Z · ci-plan-spar · escalated (partner unavailable)
The sparring partner could not review (model_unavailable). Not a plan problem: Claude Code looks at the partner, then re-runs.

### 2026-10-18T20:08Z · ci-plan-spar · escalated (partner unavailable)
The sparring partner could not review (model_unavailable). Not a plan problem: Claude Code looks at the partner, then re-runs.

### 2026-10-18T20:37Z · ci-plan-spar · escalated (partner unavailable)
The sparring partner could not review (model_unavailable). Not a plan problem: Claude Code looks at the partner, then re-runs.

### 2026-10-21T13:58Z · ci-plan-spar · drafted → approved
Converged; approved by policy converged-auto-v1. 5 lane(s) got a VTID and are handed to Kiro.
### 2026-10-21T14:45Z · kiro-hotmail-202610211408-c407 · approved (driver: plan PR update for landing)
Plan driver (seat hotmail, workflow wf_9e9eb50f8defc4b4) holds `_plan` and the heartbeat `refs/heads/collab-driver/mt-launch`.
Updated PR #4175 with `main` (06f5eef7) and listed the spec in `docs/programs/multi-tenant/program.md` (3bf815db).
`Collab handoff` stays red only on the history of this plan PR: the planner's sparring-answer commits 5d59c75b and
0d2ab816 edit lane files under `Collab-Lane: mt-launch/_plan`, and `_plan` carries commits from several sessions
(planner, ci-plan-spar, driver). History cannot be rewritten (no force-push). Same class as the messenger-ux-v2 plan PR
(#4253), which landed with `--admin` as a known §7b false positive. This driver run allows `--admin` only for the
Lane-scope spec-not-on-main case, so it does not merge. Next: an actor allowed to use the §7b false-positive `--admin`
merge (Project Manager, or a driver/owner instruction covering it) merges #4175; then `pack-intake-db` (seat hotmail) builds.
