# Internal adversarial review — mt-jobs (WS6), spec #10

Reviewer: independent internal sparring partner (fresh read, no planning context).
Date: 2026-10-15. Scope: `plan.md`, `requirements.md`, `design.md`, `tasks.md`, `handoff.md`, `lanes/*.md`.
Method: read the spec in full; verify every premise against current code at `file:line`; run the
`queue.mjs` validators (`validatePlan`, `validateLane`) on `handoff.md` and all four lane files;
confirm the BRIEF 'Internal review' criteria and every CROSS-SPEC ruling that names mt-jobs.

## Verdict

**APPROVED.** No HIGH or MEDIUM findings. Two NITs and one Open-question item (non-blocking) below.

## Validators (queue.mjs) — all clean

Ran `parseFrontMatter` + `validatePlan`/`validateLane` with correct `(fm, slug[, lane, laneIds])`
signatures (laneIds derived from the four lane file names):

- `handoff.md` → `validatePlan(fm, 'mt-jobs')` → `[]`
- `lanes/jobs-env-prepare.md` → `validateLane(...)` → `[]`
- `lanes/jobs-tenant-loop.md` → `[]`
- `lanes/jobs-automation-actor-tenant.md` → `[]`
- `lanes/jobs-community-scan-tenant.md` → `[]`

No validator error. (The first harness run reported spurious errors because I passed raw file text
instead of the slug/lane positional args; corrected and re-run clean.)

## Premise verification (against current code, 2026-10-15)

Every Problem premise re-verified at the cited `file:line` and found accurate:

| Premise | Claim | Verified |
|---|---|---|
| P1 heartbeat | `index.ts:1840` `heartbeatTenantId = process.env.DEFAULT_TENANT_ID`; `runHeartbeatCycle(heartbeatTenantId)` `:1849` | ✓ `index.ts` ~1840/1849 exact; `runHeartbeatCycle` imported from `./services/automation-executor` |
| P2 scheduled-notifications | `getTenantId` `:105` = `req.body?.tenant_id \|\| process.env.DEFAULT_TENANT_ID`; `/night-push` `:1525`, tenant `:1527` | ✓ exact. All six routes (`/night-push`, `/whats-new`, `/daily-pace-notifications`, `/recommendation-expiry`, `/signal-cleanup`, `/welcome-team-tick`) + `/health` present |
| P3 community scan | `autopilot-recommendations.ts:2281` `POST /community-scan` → `runCommunityScan` (`scan-runner.ts:255`), no tenant param | ✓ `runCommunityScan(sb, opts)` has no `tenantId`; route at 2281 |
| P4 morning brief | `morning-brief-scheduler.ts:132` already fetches each user's `tenant_id` via repo `:41` | ✓ `fetchUsersForMorningBrief` selects `user_id, tenant_id, display_name` from `app_users`; only candidate query is unscoped |
| P5 memory backfill | `memory-embedding-backfill-loop.ts:38-44` reads `MEMORY_EMBEDDING_BACKFILL_TENANT_IDS` env, not DB | ✓ env `.split(',')` tenant list, exactly as described |
| P6 automation actor tenant (7 sites) | `community.ts:274,382,482`, `match-feedback.ts:280`, `matchmaking.ts:576`, `admin-signups.ts:205`, `groups-events-tools.ts:360` (`id.tenant_id \|\| DEFAULT_TENANT_ID`) | ✓ all seven exact; `groups-events-tools.ts:360` uses `id.tenant_id \|\| process.env.DEFAULT_TENANT_ID`, the others `process.env.DEFAULT_TENANT_ID` |
| P7 EventBridge scripts | `setup-eventbridge-whats-new.sh:40` `TENANT_ID=${DEFAULT_TENANT_ID:-2e7528b8…}`; three sibling scripts same shape | ✓ line 40 exact; all four `setup-eventbridge-*.sh` scripts exist |
| M0 columns | `tenants.is_active/is_default/is_platform` (`20261014000100`), `tenant_settings.timezone` (`20261014000400`) applied | ✓ asserted applied in design.md; no migration added — consistent with "reads, not a migration" |

No new `mt-flags.ts` or `services/gateway/src/services/jobs/job-tenant-loop.ts` exists in the tree —
no duplication; the lane correctly creates both. `npm run test:operator` exists in
`services/gateway/package.json` (rule 42e premise holds), and the heartbeat path it covers
(`runHeartbeatCycle` from `automation-executor`) is exactly what lane 2 touches.

## BRIEF 'Internal review' checklist

- **Lane sizing** — 4 code lanes + 1 governance lane, each one VTID / ≤4 PRs. `jobs-tenant-loop` is the
  largest (two new files + `index.ts` + `scheduled-notifications.ts`) but stays within budget and is the
  shared foundation the other three depend on, so splitting it would create a smaller-than-one-PR
  fragment. Acceptable.
- **Paths narrow + complete** — each lane's `paths` cover every file its tasks touch plus `test/` and
  `docs/validation/`. `tasks.md` "Allowed paths" is identical to each lane's `paths`. No overlap of
  mutated source files across lanes (shared files are created in lane 2 and only *imported* by 3/4).
- **DB/code split** — N/A, no migration (M0 already applied). Correctly stated.
- **Dark by default** — `MT_RESOLUTION_V2` + `tenant_settings.feature_flags.mt.jobs_tenant_loop`; flag off
  = byte-for-byte today (`DEFAULT_TENANT_ID`), pinned by a regression test per converted site. Matches the
  program's `mt.*` flag convention (MULTI-TENANT-PLAN.md §132). Rollout flip deferred to M2 (mt-launch).
- **Standing rules** — no production writes; staging read-only (asserts active-tenant count + `/health`
  auth mode, no schedule triggered, non-GET aborted); Kiro makes no mutating AWS call (EventBridge applied
  by Claude/owner); i18n N/A (backend jobs, no user-visible strings); Bedrock-only / no Google — none
  touched. All present.
- **No duplication of DONE work or another spec** — jobs is Lane B's own area (MULTI-TENANT-PLAN.md §131);
  resolution chain / `resolvePrimaryTenant` / `TenantContext` are explicitly consumed-not-built (mt-identity
  WS1); community RLS left to mt-community-isolation / mt-network; analytics/content pipeline to mt-launch.
  Out-of-scope section is explicit and correct.

## CROSS-SPEC rulings that name mt-jobs

- **Lane count rule** (the one cross-spec ruling that applies here, though not by name): "merge sub-one-PR
  lanes…DB lanes stay separate…Claude lanes stay separate…never merge across repos." Applied: 4 kiro code
  lanes (same repo, same seat `jtadic`) are kept separate because each is a distinct VTID of 2–4 PRs with a
  real dependency order (loop → actor-tenant / community-scan), and the governance lane is kept separate as
  required. No DB lane to split. Consistent.
- No premise-correction bullet in CROSS-SPEC-DECISIONS names mt-jobs; none applies. Confirmed.

## Step-mandated confirmations

1. **`jobs-env-prepare` is executor claude** — ✓ front matter `executor: claude`, `next_actor: claude`,
   `reviewer_seat: jtadic` (a Kiro seat, as the brief requires for a Claude governance lane), no `seat`.
   Rationale is sound: the lane's sole deliverable is an EventBridge change applied against the AWS estate,
   which a Kiro session may never do (collaboration §7a — no mutating AWS call). See NIT-1 on the stated
   justification wording.
2. **Shared `mt-flags.ts` + `job-tenant-loop` gating mt-launch APIs and M2 flag flips stated under
   'Depends on'** — ✓ plan.md `## Depends on`, Downstream bullet: *"the shared `mt-flags.ts` and
   `job-tenant-loop.ts` added here gate the **mt-launch APIs** and the **M2 flag flips** — mt-launch
   depends on this spec's lane 2."* Also mirrored in `requirements.md` Successors and the `jobs-tenant-loop`
   lane body. Confirmed.

## NITs (non-blocking)

- **NIT-1 (plan.md, Fix lane 1 parenthetical).** The plan justifies the Claude executor with
  *"`scripts/aws/**` is NOT governance but EventBridge infra is Claude-owned by the brief's lane rule."*
  The brief's lane rule does not actually list EventBridge/`scripts/aws/**` as governance — `GOVERNANCE_PATHS`
  in `queue.mjs` is `.github/**`, `.claude/**`, `.kiro/steering/**`, `.kiro/automations/**`, `scripts/collab/**`,
  `CLAUDE.md`, `docs/programs/areas.yaml` only, and I confirmed `validateLane`/`scope-check` would NOT reject a
  `kiro` lane over `scripts/aws/**`. The *correct* and sufficient reason is the one the lane body itself gives:
  a Kiro lane can never make the mutating AWS call that applies the change (collaboration §7a), so the build
  must be Claude's. Suggest rewording to lead with that reason rather than implying a governance-path match
  that does not exist. Non-blocking because the executor assignment is right regardless.
- **NIT-2 (plan.md Problem 4 / scope).** Problem 4 says morning-brief's "candidate query is the only thing
  that is not tenant-loop-scoped," but no lane changes `morning-brief-scheduler.ts` (its paths are absent from
  all four lanes). This is a deliberate out-of-scope decision (the per-user tenant resolution already works),
  but it reads as an identified gap left unassigned. Suggest one line making explicit that P4 needs no change
  in this spec (or is deferred), so a reader does not expect a morning-brief lane.

## Open questions for sparring (non-blocking)

- The plan's own open question (keep `MEMORY_EMBEDDING_BACKFILL_TENANT_IDS` as a permanent override after the
  flag is on, vs. remove at M2 cleanup) is a genuine cross-spec item with mt-launch M2; correctly listed below
  `plan:end` and does not block.
