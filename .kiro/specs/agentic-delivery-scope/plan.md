---
change_class: standard
---
# plan(agentic-delivery-scope): owner spec v5 — machine gates, traceability, retries, reviews and checks to Gate 2

Author: Kiro, seat `exafyltd`, session `kiro-exafyltd-202611111044-8f1d` (Kiro Web), 2026-11-11. Premises read at
vitana-platform `592f034ae4` and vitana-v1 `b80326e519` (both `origin/main`). Companion plans: `agentic-delivery-v2`
(#4959, re-plan session #4982; this plan reuses its Wave 1 lanes) and `privacy-ledger-auth` (merged). Seats are named by
seat only.

Owner, 2026-11-11 (spec `agentic-delivery-scope` v5): *"Execute the whole spec in one run. Do not stop to ask. Do not
add any approval, sign-off, confirmation or 'owner decides' step. Do not write a question to the owner. The only human
step in the whole flow is Gate 2."*

<!-- plan:begin -->
Privacy rule for this plan and its sparring (owner spec v5): no plan text, finding, response or record quotes an email
address; cite `file:line` instead, and verify an address premise by a count, never by quoting a line.

## 0. Premises (vitana-platform `592f034ae4` unless marked v1 = vitana-v1 `b80326e519`)
1. `POST /api/v1/oasis/events` is `services/gateway/src/routes/events.ts:480` (schema `:466-474`). It has no auth
   middleware; the server sets `created_at` from the gateway clock (`:508`, `:522`); status comes from the type suffix
   (`:511-518`). `requireLedgerWriteAuth` covers only the ledger and VTID write routes
   (`services/gateway/src/middleware/ledger-write-auth.ts:4-7`; modes `:39-44`, default `log`).
2. `POST /api/v1/vtid/allocate` (`services/gateway/src/routes/vtid.ts:144`) writes the ledger row through
   `allocate_global_vtid` and emits no allocation event of its own (`:145-146`; only the sparring signal `:254-256`).
3. `GET /api/v1/vtid/:vtid` (`vtid.ts:1174-1250`) returns the ledger row and up to 100 OASIS events in time order folded
   into 4 fixed stages; nothing computes minutes per step. `vtid_ledger.created_at`/`updated_at` default to `now()`
   (`supabase/migrations/20251217000000_vtid_ledger_and_allocator.sql:35-36`); there is no status-history table.
4. STAGING-VERIFY records its result by writing PostgREST directly (`scripts/ci/staging-verify/record-oasis.sh:63-66`),
   under `BOOTSTRAP-STAGING-VERIFY` unless the result names one VTID (`:35`); the change VTIDs sit in `metadata.vtids`
   (`:44`). Caller: `.github/workflows/STAGING-VERIFY.yml:199-210`.
5. None of the step names of the v5 spec (`vtid.allocated`, `lane.claimed`, `checks.passed|failed`, `review.verdict`,
   `merge.landed`, `deploy.staging.started|finished`, `retry.scheduled`, `blocked`, `gate2.requested`) is emitted today;
   `staging.verify.passed|failed` is (`record-oasis.sh:36`).
6. Wake-ups: hourly automations, one item per run (pinned by `scripts/collab/automations.test.mjs:83-96,146-154`); DRIVER-WAKE starts a Kiro
   cloud session on a PLAN-SPAR result or a lane push when `KIRO_API_KEY` is set (`.github/workflows/DRIVER-WAKE.yml:11-28,64-75`;
   limits `scripts/collab/driver-wake.mjs:23-27`). Driver constants: alive 45 min, heartbeat 15 min, cap 6, 3 fix-forward
   attempts (`scripts/collab/plan-driver.mjs:30-34`). No backoff or retry scheduler exists in `scripts/collab` or
   `services/gateway/src/services/project-manager`.
7. The Project Manager ticks every 120 s when enabled (`services/gateway/src/services/project-manager/config.ts:24-30`,
   `loop.ts:44-77`); its decision kinds are `types.ts:260-364`; it has no dispatch or wake seam (`loop.ts:10-13`).
8. Models in code: sparring Opus 4.6 → Sonnet 4.6 → `deepseek-v4-pro` (`services/gateway/src/constants/llm-defaults.ts:115,128,149`),
   the DeepSeek tier on unless `PLAN_SPARRING_DEEPSEEK_FALLBACK_ENABLED=false` (`:156-158`, read in
   `services/gateway/src/services/plan-sparring/partner.ts:142-144`); vision stage Sonnet 4.6 → Sonnet 4.5 (`:259-266`). No
   Bedrock id for Opus 5.5 or Sonnet 5.5 exists in code; the reviewer names in
   `services/gateway/src/services/project-manager/governance.ts:39-43` are Kiro model names.
9. Bedrock adapter: InvokeModel (`services/gateway/src/providers/bedrock.ts:223-228`), base64 image blocks (`:28-33`), region
   `AWS_BEDROCK_REGION || AWS_REGION || 'us-east-1'` (`:148-150`).
10. STAGING-VERIFY runner: kinds `http`, `playwright`, `existing` (`scripts/ci/staging-verify/lib.cjs:180-207`); Playwright
    runs Desktop Chrome with `screenshot: 'only-on-failure'` (`scripts/ci/staging-verify/run.mjs:314-327`); results in
    `results.json` (`:514`); read-only guard `scripts/ci/staging-verify/staging-guard.ts:29-34,100-102`.
11. Read-only voice probes exist: `GET /api/v1/orb/health` and `/api/v1/orb/nova-sonic/health` are in
    `scripts/ci/staging-verify/smoke/gateway.json:7-8`; `GET /api/v1/ops/health/orb-bootstrap-latency`
    (`services/gateway/src/routes/ops-health-checks.ts:382`) is not.
12. v1 frontend-simple: `scripts/ci/pr-gate/lib.mjs:223-253`; `gate.mjs:63-85` exits 1 on a violation; the step runs with
    `continue-on-error` (`.github/workflows/PR-GATE.yml:103-106`) and the Verdict exits 1 only when
    `scripts/ci/pr-gate/config.json:2` has `enforce: true` (it is `false`). `.github/workflows/PR-GATE.yml` is a protected
    gate file (`scripts/collab/protected-gate-files.json`).
13. Merge bot: 8 train positions for both repos, at most 12 (`scripts/eng/gitlab-land.mjs:65,494,516-533`); a red `main`
    pauses every landing except revert and fix-main lanes (`:536-546,582-587`). Both real projects are `landing: false`
    (`infra/gitlab-engineering/settings/gitlab-settings.json:14,21`). `full-suite:*` jobs on `main` are rendered
    (`scripts/eng/pipeline-gen.mjs:103-125,179`) but not active.
14. Templates T1–T7 are defined in `.kiro/specs/agentic-delivery/plan.md:200-206`; template files are
    `infra/gitlab-engineering/ci/tpl-*.yml` (list `scripts/eng/pipeline-gen.mjs:19`); no T5 (publish) or T6 (ops-job) file
    exists.
15. The settings sync check needs `REGION` and an admin token file with `api` scope (`scripts/eng/gitlab-settings.mjs:76,901-920`).
16. Rehearsal: `scripts/eng/rehearse.mjs:77` (`LANE_COUNT` 12, also the maximum of `--agents`, `:152,172-173`); it needs the
    agent accounts' tokens from Secrets Manager (`:31-32,109`).
17. Seats: four (`docs/programs/areas.yaml:14-18`), names `SEAT_RE` (`scripts/collab/queue.mjs:65`).
18. Clone: `.github/workflows/AWS-REHEARSAL-AURORA-CLONE.yml`; `scripts/aws/rehearsal-clone.sh:141-152` reports "source
    cluster not found" for any describe failure (stderr discarded). Run 43053659836 (2026-11-11 15:58 UTC, `action:
    status`) stopped there.
19. Address-shaped strings in agent-written folders on `main` (counts only): 10 files under `.kiro/specs/**` and
    `.kiro/automations/**`; 0 under `docs/programs/**` (counted 2026-11-11; the paths stay out of this text, §8a).
20. Reused lanes of `agentic-delivery-v2` (VTID-05701..05714): `delivery-bedrock`, `review-service`, `reviewer-identity`,
    `spar-responder`, `seats`, `rules-platform`, `rules-v1`, `change-classes`, `gitlab-accounts`, `gitlab-mr-vtid`.

## 1. Goal
The v5 spec in one run: every gate before staging answered by a machine and recorded, a blocked change retried by a
machine and then recorded, and the only human step Gate 2. This plan builds the pieces of v5 that `agentic-delivery-v2`
does not: model probes and config, traceability, the retry dispatcher, the vision pass, visual and audio checks on
staging, the blocking frontend-simple gate, the merge-train pin, templates T5/T6, the 13-agent rehearsal, the clone
preparation, the cutover checklist, documentation and the address cleanup (§8a).

## 2. Owner decisions (v5 §3) and where they land
| # | Decision | Here |
|---|---|---|
| O1 | Bridge = the GitHub-kept list of `agentic-delivery` §2.2 (v2 §6.1); nothing new is built on GitHub | lanes change existing kept workflows only (STAGING-VERIFY, PR-GATE) |
| O2 | Test database = an Aurora clone made by `AWS-REHEARSAL-AURORA-CLONE`, never Supabase | lane `clone-prep` |
| O3 | Aurora cutover date: owner and Claude Code, not Kiro | `delivery-docs` lists progress and a proposed range only |
| O4 | Bedrock EU only | `model-config` rejects a non-EU region |
| O5 | DeepSeek: options A (Bedrock `eu-north-1`), B (`api.deepseek.com`), C (none); default off; enabled only when the config records its endpoint location | `model-config` |
| O6 | D9 and D10 are undefined | nothing here depends on them |
| O7 | The history rewrite is never run | unchanged |

## 3. Machine gates (v5 §4)
| Gate | Rule | Today | Built by |
|---|---|---|---|
| M1 sparring | Opus 4.6 → Sonnet 4.6 → DeepSeek (config, off) | chain exists, DeepSeek on (premise 8) | `model-config` (config); v2 `spar-responder` wires it |
| M2 class | A = frontend-simple, B = sparring, from the diff | reports only (premise 12) | `frontend-simple-block` (v1); v2 `change-classes` (GitLab) |
| M3 checks | required checks green | land-guard on GitHub | unchanged |
| M4 review | Opus 5.5 → Sonnet 5.5 → Opus 4.6 → Sonnet 4.6 → DeepSeek (config, off); protected files: two reviews | Kiro reviewer agent | `model-config` (chain); v2 `review-service` |
| M5 vision | Opus 4.6 vision; Opus 5.5 vision only once probed; never DeepSeek | none | `vision-review`, `model-probes` |
| M6 merge train | 8 positions | in code (premise 13) | `merge-train-pin` |
| M7 full suite on main | a failure pauses landings | in code (premise 13) | `merge-train-pin` |
| M8 STAGING-VERIFY | passed on the merge commit | built | unchanged |
| M9 probes | read-only visual and audio probes | voice health only | `verify-visual`, `verify-audio` |
Every model call records its tier. A gate with no tier available blocks the change (§5).

## 4. Traceability (v5 §5)
- **Steps:** one OASIS event per step through `POST /api/v1/oasis/events`, `created_at` set by the server (premise 1).
  Lane `traceability` adds an allowlist of the v5 step names: under `delivery.` (`delivery.vtid.allocated`,
  `delivery.lane.claimed`, `delivery.checks.passed|failed`, `delivery.review.verdict`, `delivery.merge.landed`,
  `delivery.deploy.staging.started|finished`, `delivery.retry.scheduled`, `delivery.blocked`,
  `delivery.gate2.requested`), plus the existing `staging.verify.passed|failed`, kept unprefixed because the Project
  Manager and the Gate 2 poster read that topic. Each allowlisted name carries its own status (`*.passed` → success,
  `*.failed` and `delivery.blocked` → error, `delivery.retry.scheduled` → warning, the rest info), so the substring rule
  of `events.ts:511-518` no longer decides them (R1-F1); other types keep that rule. Other `delivery.` types are refused
  (400). The route gets `requireLedgerWriteAuth` (mode `log` by default, so no caller breaks; staging pins `enforce` as
  for the ledger routes). For an authenticated caller it also takes `role` and `model` from the body (defaults `CICD`
  and the current value) and keeps writing `details` into `metadata` (`:531-535`), so record-oasis's fields survive the
  move (R1-F3).
- **Allocation:** `/allocate` emits `delivery.vtid.allocated` (fire-and-forget, as `:254-256`).
- **Timeline:** `GET /api/v1/vtid/:vtid/timeline` joins the ledger row with the VTID's events (by `vtid` and by
  `metadata.vtids`), in `created_at` order, with minutes between consecutive steps computed only from recorded timestamps
  (`null` when one is missing, never 0). No migration: ledger state times are the row timestamps plus the step events.
- **STAGING-VERIFY:** lane `staging-verify-wiring` sends its result through the staging gateway route with
  `GATEWAY_SERVICE_TOKEN`: one `staging.verify.<outcome>` event per VTID of the result, `details` = today's `metadata`
  object (`record-oasis.sh:41-51`), `role`/`model` as today. It keeps the direct write as the fallback when the token is
  absent (so verification is never lost). Every write still goes to the same database as today (premise 4).

## 5. Retries instead of questions (v5 §2)
Lanes `dispatcher` (the pure part: `retry.ts`, schedule and eligibility, with its test) and `dispatcher-pm` (the wiring:
the `retry` kind in `types.ts`, `decide.ts`, and its act handler in `act.ts`, which writes through the existing pm-agent
lane writer, `writers.ts:73` `applyLaneChange`, so no new seam; R1-F2). `decide.ts` and `types.ts` were in
`dispatcher`'s paths from the first draft and a `_plan` commit cannot edit a lane file; only `dispatcher-pm` changes
them, after `dispatcher` (depends_on). The decision: `retry` for a lane parked with a retryable reason (failed check,
model tier unavailable, missing prerequisite, infra failure). Backoff 15, 30, 60, 120, 240, 480 minutes: at most 6 attempts in
24 hours; each attempt unparks the lane to its `parked_from` state and records `delivery.retry.scheduled`; after the 6th
the lane stays parked with `next_actor: owner` and `delivery.blocked`. Never retried: security or data-loss risk, a
production write, a protected-file merge without its reviews, an escalated sparring verdict. The PM's own guards stay
(live mode, lease, pm-agent keys). No new wake seam: the automations and DRIVER-WAKE pick the lane up as today.
Lane `heartbeat-30`: the driver writes at most one heartbeat commit per 30 minutes (alive window 45 minutes unchanged);
it lands after v2 `rules-platform` and `rules-v1` change the rule text in both repos.

## 6. Reviews and checks
- **Model config** (`config/delivery/models.json`, lane `model-config`): chains M1, M4, M5 as §3; `region` must be an EU
  Region; DeepSeek `option: C` by default, A or B only with `endpoint_location` set; a vision chain never lists DeepSeek;
  Opus 5.5 vision is listed with `requires_probe: true`. A loader validates it and fails closed.
- **Probes** (lane `model-probes`, `scripts/eng/model-probe.mjs`): one tiny text call per chain model and one image call per
  vision model, from the role the caller runs as; output per model: tier, ok or the error class (AccessDenied, throttled,
  not found), latency; no DeepSeek image call. Run by the delivery role once it exists (prerequisite P7); the session
  role's result of 2026-11-11 (only Sonnet 4.6 answered) is recorded in the handoff.
- **Vision pass** (lane `vision-review`, `services/gateway/src/services/delivery/vision/**`): screenshots plus the change
  summary to the M5 chain through `invokeBedrock` image blocks; verdict JSON `{verdict, findings, model, tier}`; fail
  closed. A library for v2 `review-service` and for STAGING-VERIFY; no new route.
- **Visual check on staging** (lane `verify-visual`): a playwright test with `visual: true` in `staging-tests.json` takes
  screenshots at 1400×900 and 390×844 under the existing read-only guard and sends them to the M5 chain with the AWS
  role STAGING-VERIFY gets from `vars.DELIVERY_BEDROCK_ROLE_ARN` (lane `staging-verify-wiring`); no role or no tier →
  that test fails `no_tier`. Tests without `visual: true` run as today.
- **Audio** (lane `verify-audio`): the read-only `orb-bootstrap-latency` probe joins the gateway smoke suite; a Jest
  round-trip harness (recorded frames, stubbed upstream, in-memory store) runs in CI. No live voice turn on staging until
  the clone exists (O2).
- **Frontend-simple gate** (lane `frontend-simple-block`, v1, protected file): a new PR-GATE step `Change class` without
  `continue-on-error` runs `gate.mjs class`, which fails only when a VTID declares `frontend-simple` and the diff breaks
  the class; every other PR-GATE check keeps reporting under `config.json`.
- **Merge train** (lane `merge-train-pin`): tests pin 8 positions for both repos and the red-`main` pause; no behaviour
  change.

## 7. Work packages
| W | What | Lanes / status |
|---|---|---|
| W0 | reconcile the 14 `agentic-delivery` lanes | done read-only (handoff table); the stale lane files belong to seat `exafy` |
| W1 | merges, closing records, address cleanup | #4958, #4978, #4980 merged; cleanup lanes per §8a |
| W2 | C2 and the v2 re-plan | #4959 amended, #4982 sparring |
| W3 | deploy-path, build-class-retag-2, T5/T6, settings sync | `templates-t5-t6`; the two lane files need seat `exafy`; the sync check needs P5 |
| W4 | shard 4/4 at `611e93c3ca` | reproduced (v2 C2) |
| W5 | the delivery pieces | §3–§6 lanes plus the reused v2 lanes |
| W6 | Aurora progress and a proposed range | `delivery-docs` |
| W7 | clone | `clone-prep`; the workflow runs `create` only when its pre-checks pass and `status` shows no clone |
| W8 | cutover checklist, never run | `delivery-docs` |
| W9 | documentation | `delivery-docs` |

## 8. Lanes
| Lane | Repo | Executor (seat) | Paths | depends_on |
|---|---|---|---|---|
| `model-config` | platform | kiro (jtadic) | `config/delivery/models.json`, `services/gateway/src/services/delivery/model-config.ts`, `services/gateway/test/delivery/model-config.test.ts` | — |
| `model-probes` | platform | kiro (exafy) | `scripts/eng/model-probe.mjs`, `scripts/eng/model-probe.test.mjs` | `model-config` |
| `traceability` | platform | kiro (exafyltd) | `services/gateway/src/routes/events.ts`, `services/gateway/src/routes/vtid.ts`, `services/gateway/src/services/delivery/timeline.ts`, `services/gateway/test/delivery/timeline.test.ts`, `services/gateway/test/delivery/oasis-step-events.test.ts` | — |
| `staging-verify-wiring` | platform | kiro (exafyltd) | `.github/workflows/STAGING-VERIFY.yml`, `scripts/ci/staging-verify/record-oasis.sh`, `scripts/ci/staging-verify/record-oasis.test.cjs` | `traceability` |
| `dispatcher` | platform | kiro (exafyltd) | `services/gateway/src/services/project-manager/retry.ts`, `services/gateway/test/project-manager/retry.test.ts` (its paths also list `decide.ts` and `types.ts`, which only `dispatcher-pm` changes, §5) | — |
| `dispatcher-pm` | platform | kiro (exafyltd) | `services/gateway/src/services/project-manager/types.ts`, `services/gateway/src/services/project-manager/decide.ts`, `services/gateway/src/services/project-manager/act.ts`, `services/gateway/test/project-manager/retry-act.test.ts` | `dispatcher` |
| `heartbeat-30` | platform | kiro (exafyltd) | `scripts/collab/plan-driver.mjs`, `scripts/collab/plan-driver.test.mjs` | — (after v2 `rules-platform`, `rules-v1`) |
| `vision-review` | platform | kiro (exafy) | `services/gateway/src/services/delivery/vision/**`, `services/gateway/test/delivery/vision.test.ts` | `model-config` |
| `verify-visual` | platform | kiro (exafyltd) | `scripts/ci/staging-verify/run.mjs`, `scripts/ci/staging-verify/lib.cjs`, `scripts/ci/staging-verify/lib.test.cjs`, `scripts/ci/staging-verify/visual.mjs`, `scripts/ci/staging-verify/visual.test.mjs` | `model-config`, `staging-verify-wiring` |
| `verify-audio` | platform | kiro (exafy) | `scripts/ci/staging-verify/smoke/gateway.json`, `services/gateway/test/orb/live/voice-round-trip.test.ts` | — |
| `frontend-simple-block` | v1 | claude (exceptions seat `exafyltd`) | `.github/workflows/PR-GATE.yml`, `scripts/ci/pr-gate/gate.mjs`, `scripts/ci/pr-gate/__tests__/gate-class.test.mjs` | — |
| `merge-train-pin` | platform | kiro (jtadic) | `scripts/eng/gitlab-land-queue.test.mjs` | — |
| `templates-t5-t6` | platform | kiro (jtadic) | `infra/gitlab-engineering/ci/tpl-publish.yml`, `infra/gitlab-engineering/ci/tpl-ops.yml`, `scripts/eng/pipeline-gen.mjs`, `scripts/eng/pipeline-gen.test.mjs`, `infra/gitlab-engineering/ci/platform-delivery.gitlab-ci.yml`, `infra/gitlab-engineering/ci/v1-delivery.gitlab-ci.yml` | — |
| `rehearsal-13` | platform | kiro (exafy) | `scripts/eng/rehearse.mjs`, `scripts/eng/rehearse.test.mjs`, `infra/gitlab-engineering/rehearsal/seed/spec/lanes/lane-13.md`, `infra/gitlab-engineering/rehearsal/seed/spec/tasks.md`, `infra/gitlab-engineering/m2.sh` | — |
| `clone-prep` | platform | kiro (exafyltd) | `scripts/aws/rehearsal-clone.sh`, `scripts/aws/test/rehearsal-clone.sh` | — |
| `delivery-docs` | platform | kiro (exafyltd) | `docs/delivery/AGENTIC-DELIVERY.md`, `docs/delivery/AURORA-CUTOVER-CHECKLIST.md` | — |
### 8a. Address cleanup (W1: one lane per file, added as late lanes)
One cleanup lane per file of premise 19 (`addr-01`..`addr-10`, seat `exafyltd`, `paths` = that one file) and one guard
lane `addr-guard` (`scripts/collab/no-address.test.mjs`, depends on the ten). They are added to this plan's spec folder
after convergence, so their paths never reach a sparring round; PLAN-SPAR allocates late lanes on a converged,
policy-approved plan without a new round (`scripts/collab/plan-spar.mjs:26-27`). Each lane replaces the address with the
seat or role name and changes nothing else; its evidence names counts and paths only. A handoff file is edited by a
`<slug>/_plan` commit and another plan's lane file through `lane_admin: true`, the paths `queue.mjs` allows
(`classifyPath`, `scopeCheck`). The guard test scans `.kiro/specs/**`, `.kiro/automations/**` and `docs/programs/**` for
address-shaped strings (noreply, invalid and example domains excepted), prints paths and counts only, and fails on base.

## 9. Interfaces between lanes
- `config/delivery/models.json` (owner: `model-config`): `{schema: "vitana.delivery-models/v1", region, chains: {M1,
  M4, M5: [{tier, provider, model, requires_probe?}]}, deepseek: {option: "C"|"A"|"B", endpoint_location: null|string}}`.
  Readers: `model-probes`, `vision-review`, `verify-visual`, v2 `review-service`, v2 `spar-responder`.
- Vision verdict (owner: `vision-review`): `{verdict: "accept"|"block"|"no_tier", findings: [], model, tier}`; `verify-visual`
  writes it per test into `results.json`.
- Step event body (owner: `traceability`): the existing schema (premise 1) with `type` from the allowlist and
  `details.{lane, seat, attempt, model, tier}`.

## 10. Parallel and hot files
At most 6 build lanes at once and at most 2 sparring sessions. No file is changed by two lanes of this plan
(`decide.ts` and `types.ts` are listed in two, changed by `dispatcher-pm` only, §5). Across plans:
`.kiro/automations/*.md` is also in v2 `seats` (it waits for `addr-08`..`addr-10`); `scripts/collab/plan-driver.mjs`
follows v2 `rules-platform`. Governance-path lanes (`staging-verify-wiring`, `heartbeat-30`, and the automation-file and
guard lanes of §8a) carry `reviewer_seat: agent:vitana-lane-reviewer`.

## 11. Prerequisites (v5 §6) — each one fails closed for the package that needs it; the others continue
| P | Missing today | Package that waits |
|---|---|---|
| P1 vCPU 96 (engineering account) | not requested | runner capacity for the cut |
| P2 Bedrock quotas and model access | the session role invokes only Sonnet 4.6 | M4, M5 tiers |
| P3 13 GitLab accounts | 4 exist | `rehearsal-13` run, seats 5–12 |
| P4 Kiro API keys | not stored | dispatcher wake of idle seats |
| P5 GitLab read credential | 403 | job 1084 log, settings sync check |
| P6 Aurora clone | `status` stopped at the source check (premise 18) | `clone-prep` follow-up, live voice and write-flow checks |
| P7 IAM roles | no delivery role | `model-probes` run, M4/M5 calls, `verify-visual` |

## 12. Tests and commands
Each lane writes its test first and records it red on `origin/main`: gateway Jest (`npx jest <files>`), `node --test`
for `scripts/**/*.test.mjs`, `bash scripts/aws/test/rehearsal-clone.sh`, v1 `node --test scripts/ci/pr-gate/__tests__`.
Preflight before every push; gateway lanes also `npm run typecheck` in `services/gateway`. Gateway-deploying lanes carry
`docs/validation/<VTID>/staging-tests.json` with read-only probes (the timeline route answers JSON with a service token,
an unauthenticated step write is rejected only once staging pins `enforce`).

## 13. Measurement
`docs/validation/<plan VTID>/timings.json` (`collaboration.md` §8b) and, once `traceability` lands, the timeline route per
VTID: minutes between recorded steps only.

## 14. Risks
- A step event schema that is too loose lets a caller write any type: the allowlist applies to `delivery.*` only, and the
  route keeps today's behaviour for other types.
- Fail-closed visual and vision checks stop a UI change while P2/P7 are missing; only tests that opt in with `visual:
  true` are affected.
- Retries can repeat a failing run: the backoff caps attempts at 6 in 24 hours and never retries the non-retryable reasons
  of §5.
- Two cleanup lanes edit governed files of other plans through the paths `queue.mjs` allows (`_plan` commit,
  `lane_admin`); a refusal is recorded and the lane parks.
- The clone holds production data; nothing here creates it until its pre-checks pass.

## 15. Unchanged
PUBLISH and production stay the owner's. No migration. No new GitHub workflow. STAGING-VERIFY's read-only guard. The
partner chain until v2 `spar-responder` reads `models.json`.

## 16. Decisions taken
1. Reuse v2's lanes; this plan adds only what v2 lacks, so no VTID is spent twice.
2. Step names live under `delivery.` so they never collide with existing topics (`staging.deploy.*`, premise 5).
3. Ledger state times come from the row timestamps and the step events; no status-history migration (stop 1 avoided).
4. The dispatcher unparks; it starts no session (no new wake seam, premise 7).
5. Vision is a library, not a route, so `services/gateway/src/index.ts` (v2 `review-service`) is untouched.
6. `clone-prep` makes the pre-check say why the source is unreadable before any `create`.
7. The cleanup lanes are late lanes (§8a): naming the address-holding files in a sparred text would invite a round to
   quote them (the closed #4977 round did), against the owner's privacy rule.
<!-- plan:end -->
