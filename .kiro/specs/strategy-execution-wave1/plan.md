---
change_class: standard
---
# plan(strategy-execution-wave1): first execution wave of the approved Vitanaland strategy (discovery, traceability design, risk register, capacity, live-evidence pack, Healthy Million readiness, destination identity, Mental Health label)
Author: Kiro, seat `exafy`, session `kiro-exafy-202611110004-e38b` (Kiro Web). Repos `exafyltd/vitana-platform`, `exafyltd/vitana-v1`.
Premises pinned to `origin/main` vitana-platform `6dc6e1ba0c`, vitana-v1 `e31bf4627f`.
<!-- plan:begin -->
Pins (both repos, every file:line below and in the lanes is checked against these): vitana-platform `6dc6e1ba0c18252ec2f3fbf5651d245e200f9835`,
vitana-v1 `e31bf4627ff3c705c20f8e6b718ce4dd03353b7f`. A lane that starts on a newer `origin/main` re-verifies its citations
there first and records both SHAs in `commands.log`.
## 1. Goal
Owner, 2026-11-11 ("Final strategy review — conditional approval and execution authorisation", strategy commit
`fb77090e1ffc7d1ef3c250b0aa721768c3df9425` in GitLab project `vitana/vitanaland-strategy`): *"Proceed with the approved
discovery and preparation work immediately."* Authorised now: repository review and documentation, architecture and
dependency mapping, Command Hub discovery, existing programme inventory, non-destructive audits, integration design,
execution planning, evidence gathering, VTID intake for approved discovery tasks. *"The app must explicitly identify the
fifth pillar as Mental Health, not merely Mental."* Not authorised by this plan: production migrations, tenant identity
or authorisation changes, RLS or memory security changes, production deployment, financial execution, public
publishing, credential or permission changes, autonomy activation, changes to multi-tenant acceptance criteria.

## 2. Today (evidence)
- Command Hub has 26 sections, 25 in the sidebar plus routable Feedback: `services/gateway/src/frontend/command-hub/app.js:3236-3549`
  (`NAVIGATION_CONFIG`), dispatcher `:8050-8478`, sidebar has no role or tenant filter `:5788-5835`. No view of plans,
  lanes, claims, seats or driver heartbeats. Delivery reads ledger + OASIS through `routes/delivery.ts:101`.
- PUBLISH: `routes/operator.ts:2202-2219` evaluates the STAGING-VERIFY gate then sets `allowed: true` ("removed by owner
  decision 2026-11-08"); `CLAUDE.md` rules 46 and 50 still say no PUBLISH on a failed verification.
- VTID: `supabase/migrations/20251217000000_vtid_ledger_and_allocator.sql:65,82-126` (`VTID-` + 5 digits); CI allocation
  `scripts/collab/plan-spar.mjs:231-265`; gate in log mode `20261004110000_vtid_04868_plan_sparring_gate.sql:117-123`.
  OASIS `oasis_events` (`20251209000000_add_task_stage.sql:10-36`) has a free-text `vtid`, no FK; writer
  `services/gateway/src/services/oasis-event-service.ts:59`. Kiro/Claude session work is recorded in git trailers and
  claim refs only (`.claude/rules/collaboration.md` §3, §5). GitLab MR events map to VTIDs in
  `services/gateway/src/services/gitlab-events/delivery-mapper.ts:274-342`.
- Autonomy risks still present at HEAD: production default verifier URL `self-healing-snapshot-service.ts:17`;
  rollback "completed" without a rollback `:363-472`; `SH-FALLBACK-<ts>` VTID `self-healing-diagnosis-service.ts:246-247`;
  event-loop cursor reset/advance/mid-batch skip `autopilot-event-loop.ts:872-882,902-910,913-931`; claim fail-open
  `routes/worker-orchestrator.ts:1261-1264` + `20260413000000_fix_claim_accepts_scheduled.sql:36-72`; tenant-blind
  dedupe `routes/self-healing.ts:143-175`, `self-healing-injector-service.ts:31-35`; `alert-workflow://` rejection
  `routes/self-healing.ts:480-497`; no `services/worker-runner/` and no `AWS-PROD-DEPLOY-WORKER-RUNNER.yml` although
  `.claude/rules/infrastructure.md` §1b names both; no Dispatcher service.
- Seats: `docs/programs/areas.yaml:14-18` names four Kiro seats; `CLAUDE.md` says Claude Code is retired. The owner's
  target model is 12 Kiro + 1 Claude Code accounts.
- Memory-fact RPCs: revoked from `PUBLIC, anon, authenticated` by `20261010164100_vtid_05041_definer_functions_lockdown.sql:37-47`
  (self-check `:145-161`) and from `migrate` by `20261013090000_vtid_05125_memory_functions_revoke_migrate.sql`; no live
  `has_function_privilege` result is recorded (`docs/validation/VTID-05041/commands.log:36-37` still a placeholder).
- Destination identity: vitana-v1 `src/App.tsx:818` (`/` → `ShareEntry`/`Index`), `:831` (`/auth` → `/maxina`);
  `src/config/domain-tenant-mapping.ts:6-8` maps `vitanaland.com`, `www.` and `e.` to Maxina; `apps/mobile/app.config.ts:26-28`
  (iOS `com.exafy.maxina.dev`, Android `com.vitanaland.app.dev`), scheme `maxina` `:217`. No Healthy Million in either repo.
- Fifth pillar: code key `mental` (`services/gateway/src/lib/vitana-pillars.ts:22-27`); user labels read "Mental" in
  vitana-v1 `src/i18n/en/health.json:42`, `vitanaIndex.json:15`, `newsCard.json:38`, `healthNative.json:292`,
  `screens.json:861,3401,4888,9585`, `vcal.json:52`, and the matching keys in the other ten locales.

## 3. Interfaces between lanes
The six discovery lanes write Markdown under `docs/programs/strategy-execution/` only, one file per lane, plus
`docs/validation/<VTID>/`. They read code; they change no code, schema, flag, workflow or rule file. A finding that needs
a change becomes a "proposed follow-up" line (title, files, risk, owner) for a later sparred plan. `delivery-capacity`
proposes CLAUDE.md wording but does not edit `CLAUDE.md` (protected gate file). `security-evidence` adds one read-only
SQL file that an authorised operator runs; the lane never connects to a database. `mental-health-label` is the only lane
that changes product text (vitana-v1 i18n JSON values only; no key renames, no code).

## 4. Lanes
1. `ch-discovery` (vitana-platform) → `docs/programs/strategy-execution/command-hub-discovery.md`: per section and tab:
   render function, API routes (with route file:line and auth middleware), data tables/RPCs, permissions, status class,
   GitLab/agent-supervision gaps; target supervisory design reading existing sources (ledger, OASIS, lane files, claim
   refs, GitLab webhook events); the PUBLISH rule/code conflict stated for the owner (no recommendation to change code).
2. `oasis-traceability` (vitana-platform) → `.../oasis-vtid-traceability.md`: design to trace account/session, VTID,
   repo and commit, execution start/end, lifecycle events, decisions, evidence, verification, deployment and outcome
   through the existing `oasis_events`, `vtid_ledger`, git trailers, GitLab webhook and PM emit seam; no new ledger;
   options for the missing ledger link (validated `vtid` on write vs FK) with compatibility and the log-mode gate left
   unchanged.
3. `autonomy-risks` (vitana-platform) → `.../autonomy-risk-register.md`: each risk with severity, current status,
   tenant-isolation, security, execution-integrity and financial/publishing impact, owner, dependencies, remediation,
   verification; Dispatcher and worker-runner facts stated as found. It has an explicit entry for the event-type gap:
   `self-healing.rollback.completed` (`self-healing-snapshot-service.ts:460-472`) is emitted when only a rollback request
   was recorded, so the follow-up must fix the event semantics as well as the missing rollback mechanism.
4. `delivery-capacity` (vitana-platform) → `.../delivery-capacity.md`: actual seats, sessions in lane logs and trailers,
   GitHub/GitLab identities, Claude Code status; available capacity vs the 13-account target; proposed CLAUDE.md and
   `areas.yaml` wording for the owner.
5. `security-evidence` (vitana-platform) → `.../security-live-evidence.md` + `scripts/sql/readonly/strategy-memory-grants-check.sql`
   (SELECT-only: `has_function_privilege` for the four memory functions × `anon`, `authenticated`, `service_role`,
   `migrate`; `pg_policies` and `relrowsecurity` for memory and tenant tables). The doc states that sensitive memory,
   tenant, permission and financial implementation stays blocked until an authorised operator records the output.
6. `hm-readiness` (vitana-platform) → `.../healthy-million-readiness.md`: the 19 acceptance criteria of the strategy's
   Healthy Million milestone checked against the Maxina implementation (location, tenant-scoped or hardwired, status),
   with prerequisites from `docs/multitenancy/MIGRATION-QUEUE.md` and the mt-* specs; no tenant created.
7. `destination-identity` (vitana-platform) → `.../destination-identity-strategy.md`: vitanaland.com as ecosystem, Maxina
   as destination, Vitana universal, migration-aware path (domain map, `/auth` default, golden tests, iOS bundle id,
   scheme) coordinated with `mt-frontend-brand-r3`; no migration.
8. `mental-health-label` (vitana-v1) → the value of every pillar-name label of the fifth pillar in `src/i18n/<locale>/`
   (`health.json`, `vitanaIndex.json`, `newsCard.json`, `healthNative.json` pillar name only, `screens.json` pillar-name
   keys, `vcal.json`) reads "Mental Health" in its language (de "Mentale Gesundheit" first, du-form unaffected); keys
   unchanged; sentences and plan names that already say mental health are left alone; layout checked for the longer
   label (desktop 1400×900, mobile 390×844, RTL ar). The lane's `docs/validation/<VTID>/acceptance.md` lists every other
   surface that still names the fifth pillar "mental" without "health", each as a proposed follow-up with file:line: the
   gateway `pillarLabel()` (`vitana-platform/services/gateway/src/lib/vitana-pillars.ts:29-32`, "Human-facing label for
   voice/UI") and its call sites, the native app (`apps/mobile`) labels, and server-shipped UI text. Those surfaces are
   code changes (gateway behaviour, native build) and get their own sparred plan; this lane does not claim to finish the
   owner's instruction for them.

## 5. Parallel, shared and hot files
Lanes 1–7 are independent (separate files) and may run in parallel up to the cap. Lane 8 touches i18n shards (hot
files per namespace): it is the only lane on them; it must coordinate with any open lane on the same shards at land time.

## 6. Tests and commands
Discovery lanes: `node scripts/collab/preflight.mjs` and `node --test scripts/collab/*.test.mjs` green; every file:line
in the doc resolves on `origin/main` (a lane-local script in `docs/validation/<VTID>/commands.log` that greps each
citation); the doc contains no proposal presented as implemented. `security-evidence`: the SQL file parses (contains
only `SELECT`/`WITH`, checked by a test `scripts/sql/readonly/strategy-memory-grants-check.test.mjs` that fails on any
other statement keyword). `mental-health-label`: a Vitest `src/i18n/pillar-mental-health-label.test.ts` that fails on
base (asserts the listed keys equal the new values in en and de and are non-empty in every locale), `npm test`,
`npm run lint`, `npm run i18n:inventory`; read-only staging spec `tests/e2e/staging/mental-health-label.staging.spec.ts`
asserting the Health screen shows the new label; STAGING-VERIFY on the merge commit.

## 7. Measurement
`docs/validation/<plan VTID>/timings.json` (`vitana.plan-timings/v1`).

## 8. Risks
A discovery doc goes stale; each carries its pinned HEAD. The label lane can overflow small cards in some locales; the
screenshot step covers that. No lane changes behaviour outside the label text.

## 9. Unchanged
All code, schemas, RLS, grants, flags, the plan-sparring gate mode, PUBLISH behaviour, `CLAUDE.md`, `areas.yaml`,
multi-tenant specs and acceptance criteria, tenants, native app identifiers.
<!-- plan:end -->
