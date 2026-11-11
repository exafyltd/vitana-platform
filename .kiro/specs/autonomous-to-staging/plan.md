---
change_class: standard
---
# plan(autonomous-to-staging): remove every human gate before staging verification (rules, protected-file merge, parking, Pipeline B everywhere, isolated staging database, autonomous staging migrations, Kiro AWS execution access)
Author: Kiro, seat `exafy`, session `kiro-exafy-202611110920-270b` (Kiro Web). Repos `exafyltd/vitana-platform`, `exafyltd/vitana-v1`.
<!-- plan:begin -->
Pins: vitana-platform `e7e0c116fc135f16f621d91a0ab296be327da9d7`, vitana-v1 `02681143da1fe3f2145817289923242dc494ec09`. A lane
that starts on newer heads re-verifies its citations there.

## 1. Goal
Owner directive 2026-11-11 ("Remove all human-in-the-loop delivery gates — Loop Engineering, autonomous execution to
staging verified"): *"The complete delivery lifecycle, from initial planning to verified staging, must be autonomous.
ZERO HUMAN-IN-THE-LOOP INTERVENTION. ... The only normal human decision point is the final production publishing
decision."* It names this work, supersedes the conflicting rules, and states that agent changes to engineering rules
follow autonomous machine verification. This plan is that instruction's plan for the protected gate files it changes
(`collaboration.md` §3a): the owner instruction naming this plan is recorded in `handoff.md`.

Unchanged and out of scope: production. PUBLISH (Command Hub) or an owner command in a session stays the only route to
production (CLAUDE.md rules 49–50a, `collaboration.md` §7c); production migrations stay part of that decision; no
suite ever targets production; staging tests stay read-only against any shared database.

## 2. Today (human steps before staging, file:line at the pins)
| # | Gate | Where | Kind |
|---|---|---|---|
| H1 | Gate 1 for locally sparred plans; stop cases (a) outside plan, (c) security/data-loss, (d) 3 failed fix-forwards | `CLAUDE.md:27, 56-59`; v1 `CLAUDE.md:48, 79` | rule |
| H2 | Protected gate files need an owner instruction | `CLAUDE.md:82`; `collaboration.md:136-145, 218, 228, 270-271`; v1 `CLAUDE.md:107` | rule |
| H3 | Same, enforced | `scripts/collab/queue.mjs:91-107, 240, 1033-1034`; `scripts/collab/land-guard.mjs:108-110, 54`; `services/gateway/src/services/project-manager/governance.ts:4-22, 48-107`; `PR-GATE.yml:168-174` | code |
| H4 | Migrations need owner approval of file and target | `collaboration.md:209-213, 312-322`; `.kiro/steering/vitana-owner-autonomy.md:40`; `.kiro/pipeline/quality-checks.md:73` | rule (RUN-MIGRATION.yml and v1 `apply-*.yml` have no environment reviewers) |
| H5 | 3 failed fix-forwards park the lane: `next_actor: owner` in `.kiro/pipeline/driver.md:52` (`common-rules.md:30-31` names the stop and the five-part message without a `next_actor`), but `next_actor: claude` (when available) in `collaboration.md:247-248`; the two texts disagree and `rules-platform` resolves both to quarantine | rule |
| H6 | Escalated sparring verdict goes to the owner; escalated session needs `exafy_admin` approval | `collaboration.md:209-210`; `planning.md:65`; `driver.md:49`; `plan-sparring-service.ts:461-480`; `scripts/collab/plan-spar.mjs:398-411` (parks to `claude`) | rule + code |
| H7 | Product autonomy settings need explicit approval | `CLAUDE.md:201` (NEVER 34) | rule |
| H8 | Owner stop table | `.kiro/steering/vitana-owner-autonomy.md:40-52` (rows 1, 3, 4, 5, 6, 7, 12, 13); v1 copy | rule |
| H9 | v1 "when in doubt ask"; Commerce friction and Spotlight contract need owner approval | v1 `CLAUDE.md:30, 341`; v1 `.claude/rules/design.md:24` | rule |
| H10 | Pipeline B only in vitana-v1 `src/**`; no Kiro VTID path (`VTID-ALLOCATE.yml:15-26` is dispatch-only, "for Claude Code") | v1 `scripts/ci/pr-gate/lib.mjs:217-253`; `CLAUDE.md` rules 51, 51a, §4.1 | rule + code |
| H11 | Staging shares the production Supabase project, so any staging migration is a production write | `CLAUDE.md` rule 48; `collaboration.md:314-315`; v1 `CLAUDE.md` "Why no host is exempt"; v1 `apply-*.yml` hard-wire `PROJECT_REF=inmkhvwdcuyhnxkgfvsb` | architecture |
| H12 | Kiro has no AWS credentials; session tools never write AWS | sandbox (strategy EV-121); `collaboration.md` §7a | access |

No CODEOWNERS file and no GitHub `environment:` reviewers exist in either repo (checked at the pins).

## 3. Target
1. **Rules (H1, H2, H4–H9):** every pre-staging owner stop becomes a machine mechanism:
   - Gate 1 is replaced by machine sparring for all plans (local sparring records go through PLAN-SPAR).
   - Protected gate files merge on **two independent reviewer-agent accepts from two different chain models** on the
     current head plus every required check green (lane `machine-gate-protected`). Two models, not one, because these
     files define the gates themselves. Because both models are one vendor family, a **mechanical invariant check**
     is added as a required CI step (`scripts/collab/gate-invariants.mjs`, run in `Collab tests`): the protected list
     is non-empty and still contains every gate file, including itself; `mergeDecision` still refuses zero or one
     accept and two accepts of one model; scope-check still refuses a protected file from an untrusted lane; the
     staging prod-reference guard still lists every production identifier (conditional: while
     `scripts/ci/staging-prod-ref-guard.mjs` is absent the invariant is skipped with the logged note
     `staging-prod-ref-guard: not yet present, invariant deferred`; once `staging-db-isolation` lands, the daily run on
     `main` enforces it). The check fails closed and cannot be
     changed in the same PR that changes the files it protects: in PR CI both the script and its expectations are
     loaded from the merge-base (`git show "$BASE:scripts/collab/gate-invariants.mjs" > "$RUNNER_TEMP/…"`, the pattern
     `PR-GATE.yml:169` uses for `queue.mjs`); only `GATE-INVARIANTS.yml` on `main` runs the `main` version.
     Bootstrap: on the `machine-gate-protected` PR itself the merge-base has no expectations, so the check prints
     `gate-invariants: no baseline on merge-base (bootstrap)` and passes; that PR's authority is the owner instruction
     plus the reviewer-agent accept (§3a). A new workflow `GATE-INVARIANTS.yml` (lane `gate-invariants-ci`, after `machine-gate-protected`; today no workflow runs
     `scripts/collab/*.test.mjs` on push: `PR-GATE.yml:14-16` is `pull_request` only and `CI-SCRIPTS-TEST.yml:19-26`
     filters other paths) runs on every push to `main` and daily, and checks `main` itself; it also checks every merge commit on `main`
     that touches a protected gate file: the merged PR must carry two review entries (`Collab-Verdict: accept`, distinct
     `Collab-Reviewer` models from the chain, `Collab-Reviewed-Head` equal to the merged head) or, for the bootstrap
     lanes only, the logged owner-instruction authority of this plan; otherwise the run fails loudly and emits an
     OASIS event `collab.gate.bypass_detected` and fails loudly if any invariant is missing, so the first version is verified as soon
     as it lands.
   - Migrations: applied by the pipeline to the **isolated staging database only** (lanes `staging-db-isolation`,
     `staging-migrations-auto`). Until that database exists, a migration lane waits in machine state
     `blocked: isolated-staging-db` (not an owner question). No migration ever reaches the production database before
     PUBLISH.
   - 3 failed repairs, an escalated sparring verdict, or a security/data-loss finding → **machine quarantine**: lane
     `state: quarantined`, `next_actor: kiro`, exceptions seat; the driver opens a re-plan revision, continues other
     eligible lanes, and never reports the quarantined work as staging verified. Every transition into and out of
     quarantine emits an OASIS event (`collab.lane.quarantined` / `collab.lane.unquarantined`, payload: lane key,
     VTID, reason, evidence link) through the existing `/api/v1/events/ingest` path.
   - NEVER 34 is narrowed to production autonomy settings; staging-scoped settings change through the pipeline.
   - The owner stop table is replaced by: production publish (human) and the machine quarantine rules.
2. **Pipeline B everywhere (H10):** `frontend-simple` covers vitana-v1 `src/**`, `public/**`, `apps/mobile/src/**` (deny
   list extended: native navigation, parity ledger, `app.json`/`eas.json`, generated) and vitana-platform Command Hub
   frontend `services/gateway/src/frontend/command-hub/**` (deny: `app.js` routing/auth sections are not separable, so
   only `*.css`, `index.html` cache-bust and `src/**` view modules qualify; exact list in lane). VTIDs come from CI:
   `VTID-ALLOCATE.yml` gains a `pull_request_target` trigger (the workflow definition and scripts always come from
   the base branch; the PR's files are read as data with `git show <pr head>:<path>` and its file list from the API;
   no PR code is executed) that allocates when a PR declares `change_class: frontend-simple` and the diff qualifies,
   and commits the VTID into `scope.json` as `ci-vtid-allocate` (`permissions: contents: write` on that job only, same-
   repo branches only). `VTID-ALLOCATE.yml`, `GATE-INVARIANTS.yml` and `scripts/collab/gate-invariants.mjs` are added to
   `protected-gate-files.json` (lane `machine-gate-protected`); the invariant check asserts that `GATE-INVARIANTS.yml`
   exists and keeps its push-to-`main` trigger. No sparring,
   no reviewer round; PR-GATE, build and STAGING-VERIFY stay.
3. **Isolated staging database (H11):** a separate staging data plane in account `472838866351`, `eu-central-1`:
   - a dedicated Aurora PostgreSQL cluster `vitana-aurora-staging`, built from `supabase/migrations/**` (schema) plus a
     synthetic seed; never restored from production data; its own KMS key, subnet group and security group, which
     admits only the staging gateway and staging PostgREST tasks;
   - the existing staging PostgREST-Aurora proxy (`AWS-STAGE-DEPLOY-POSTGREST-AURORA-PROXY.yml`) repointed at it;
   - gateway staging (`AWS-STAGE-DEPLOY-GATEWAY.yml`) and the v1 staging frontend use only staging endpoints and
     staging keys;
   - a guard script, run in every staging workflow, that fails when a staging config, a staging workflow YAML or a
     staging task-definition template names the production project ref `inmkhvwdcuyhnxkgfvsb`, the production Aurora
     cluster, a production role secret (`AWS_PROD_ROLE_ARN`) or a production secret name or ARN, including
     `vitana/aurora/prod/postgrest-authenticator-uri` hardcoded today in
     `AWS-STAGE-DEPLOY-POSTGREST-AURORA-PROXY.yml:116,139`.
   Auth: staging needs its own auth issuer. Decision taken (conservative, no new SaaS): a separate Supabase project
   for staging auth only is **not** chosen without cost approval; the lane implements staging auth on the existing
   gateway JWT path against the staging database and records the gap if a flow still needs Supabase GoTrue.
4. **Autonomous staging migrations:** `RUN-MIGRATION.yml` gains target `staging`, which resolves only to the isolated
   cluster. Today `scripts/aws/aurora-apply-migration.sh:37` hardcodes `CLUSTER=vitana-aurora-prod` (arguments today:
   `--file`, `--dry-run`, `--allow-non-transactional`) and the Aurora job assumes `secrets.AWS_PROD_ROLE_ARN`
   (`RUN-MIGRATION.yml:151`). New interface: a separate entry point `scripts/aws/staging-db-apply-migration.sh --cluster
   <name> --file <f>` (cluster required, no default, refuses `vitana-aurora-prod` unconditionally, no override); the
   existing production script and its hardcoded path stay as they are, dispatch-only after PUBLISH. The workflow's
   `target: staging` resolves to `--cluster vitana-aurora-staging`, and the `staging` target
   assumes a dedicated staging migration role (`AWS_STAGING_MIGRATION_ROLE_ARN`, permitted only on
   `vitana-aurora-staging` and its secret), never `AWS_PROD_ROLE_ARN`; a new job runs on merge to `main` for changed `supabase/migrations/**` files in timestamp order: dry-run
   lint, apply, schema drift check (`MIGRATION-DRIFT-CHECK`), app compatibility suite (gateway Jest DB tests against
   the cluster), and on failure restore the pre-apply Aurora snapshot (taken by the job) and quarantine the lane.
   Evidence: run URL, snapshot id, schema hash in `docs/validation/<VTID>/`. The production targets `supabase` and
   `aurora` stay dispatch-only and are used only after PUBLISH.
5. **Kiro AWS execution access (H12):** IAM as code in `infra/kiro-access/`:
   - account `841276716213`: role `kiro-engineering-admin` (AdministratorAccess) assumable by the Kiro automation
     principal. Premise: the account holds the engineering platform only, GitLab EE `gitlab.vitanaland.com`, its
     runners, backup buckets and CI cache (`.kiro/specs/eng-gitlab-m1/plan.md:13-14, 87-92`; `eng-gitlab-m2/plan.md:65,
     86`); no Vitana customer service runs there. The lane first records a read-only inventory of the account (resource
     list from the apply workflow) in `docs/KIRO-AWS-ACCESS.md`. Because the account holds every repository copy and
     its backups, the role keeps explicit denies on deleting the GitLab instances, their EBS volumes and the backup
     buckets (`ec2:TerminateInstances`, `ec2:DeleteVolume`, `s3:DeleteBucket`, `s3:DeleteObject*` on those ARNs), and an
     explicit deny on `secretsmanager:GetSecretValue` and `PutSecretValue` for `vitana/engineering/gitlab/root-password`,
     `runner-token` and `github-mirror-token`;
   - account `472838866351`: role `kiro-staging-operator` built as an **allow-list**: it grants write actions only on
     staging resources named by exact ARN (the `vitana-aurora-staging` cluster and its snapshots, the `vitana-gateway`
     staging service and task family, the staging PostgREST service, `vitana/*/staging*` secrets, the staging KMS key,
     the staging security and subnet groups) and read-only (`Describe*`, `List*`, `Get*` except secret values) on the
     rest; everything else is implicitly denied. On top, explicit `Deny` statements on the known production ARNs
     (`vitana-aurora-prod`, `*-awsdr` ECS services, `vitana-alb-prod`, production secrets and KMS keys) and an IAM
     permissions boundary the role cannot change (`iam:*` on itself denied). Account `472838866351` is the
     Organizations management account (SCPs do not apply), so this is the control. Drift check: a required CI step on
     every PR touching `infra/kiro-access/**` and a daily scheduled run list every ECS service, RDS cluster, secret and
     KMS key in the account and fail when an allow-list entry matches a non-staging resource or a production resource
     lacks its explicit deny. A separate staging data account stays the stronger boundary; the lane records it as a
     strategy decision with target date 2026-12-31;
   - every assumption tagged with the session id and logged to CloudTrail; an OASIS `infra.kiro_access.*` event per
     session start.
   Applied by a `workflow_dispatch` workflow on the existing OIDC role. The credential the Kiro environment uses as
   the source principal is placed in the environment's secret store by the workflow output or the owner; it never
   appears in chat or git.
6. **Strategy repository:** its MRs from `kiro/*` merge automatically when the pipeline passes (done directly on
   GitLab, outside this plan; recorded in the strategy repo).

## 3a. Bootstrap (how the first protected-gate lanes merge)
Today `land-guard.mjs:107-108` and `governance.ts:15-19` never merge a protected gate file; the authority is the owner
instruction naming the plan plus a reviewer-agent accept on the current head (`collaboration.md` §3a, §7b). This
plan has that instruction (owner directive 2026-11-11, recorded in `handoff.md`). So, until `machine-gate-protected`
is on `main`, each protected-gate lane merges like this, with no further human step:
1. reviewer-agent accept on the current head (`land-guard.mjs review` passes);
2. every check run's latest attempt green and the PR up to date (`land-guard.mjs checks` passes);
3. the driver merges with `gh api -X PUT repos/<repo>/pulls/<n>/merge -f sha=<reviewed head> -f merge_method=squash`
   (sha-pinned, never `--admin`), and logs `merge: <sha>`, `authority: owner instruction 2026-11-11 (plan
   autonomous-to-staging) + reviewer-agent accept <head>`.
`machine-gate-protected` lands first. From then on protected files merge through `land-guard.mjs merge` under the
two-model rule and the invariant check. The protected-gate lanes are `executor: claude` only because `queue.mjs:1032`
admits protected files for that executor; while Claude Code is unavailable a Kiro seat builds them (exceptions path,
§7), and the reviewer agent accepts. `rules-platform` also removes the sentence "Only protected gate files (§3a) still
wait for owner/Claude review" (`collaboration.md:228`).

## 4. Lanes
| Lane | Repo | Paths (summary) | Depends on |
|---|---|---|---|
| `rules-platform` | vitana-platform | `CLAUDE.md`, `.claude/rules/collaboration.md`, `.kiro/steering/vitana-owner-autonomy.md`, `.kiro/steering/vitana-pipeline.md`, `.kiro/pipeline/{driver,common-rules,planning,quality-checks}.md`, `docs/DEPLOYMENT-PIPELINE.md` | `machine-gate-protected`, `quarantine` |
| `rules-v1` | vitana-v1 | `CLAUDE.md`, `.kiro/steering/vitana-owner-autonomy.md`, `.claude/rules/design.md` | `rules-platform` |
| `machine-gate-protected` | vitana-platform | `scripts/collab/queue.mjs`, `scripts/collab/land-guard.mjs`, `scripts/collab/protected-gate-files.json`, `scripts/collab/gate-invariants.mjs`, `services/gateway/src/services/project-manager/governance.ts`, tests | none |
| `gate-invariants-ci` | vitana-platform | `.github/workflows/GATE-INVARIANTS.yml`, `scripts/ci/workflow-trigger-check.test.mjs` | `machine-gate-protected` |
| `quarantine` | vitana-platform | `scripts/collab/plan-spar.mjs`, `scripts/collab/plan-driver.mjs`, OASIS event emitter in `scripts/collab/`, `services/gateway/src/services/plan-sparring/plan-sparring-service.ts` (escalation → quarantine, no `exafy_admin` path needed for staging), tests | none |
| `pipeline-b-v1` | vitana-v1 | `scripts/ci/pr-gate/lib.mjs`, `scripts/ci/pr-gate/__tests__/**` | none |
| `pipeline-b-platform` | vitana-platform | `scripts/ci/pr-gate/**`, `.github/workflows/PR-GATE.yml`, `.github/workflows/VTID-ALLOCATE.yml`, tests | none |
| `staging-db-isolation` | vitana-platform | `infra/staging-db/**`, `.github/workflows/AWS-STAGE-PROVISION-DB.yml`, `scripts/aws/staging-db-*.sh`, `scripts/ci/staging-prod-ref-guard.mjs`, `.github/workflows/AWS-STAGE-DEPLOY-{GATEWAY,POSTGREST-AURORA-PROXY}.yml`, `docs/STAGING.md` | none |
| `staging-frontend-isolation` | vitana-v1 | `.github/workflows/{STAGE,AWS-STAGE}-DEPLOY-FRONTEND.yml`, `.env.staging` | `staging-db-isolation` |
| `staging-migrations-auto` | vitana-platform | `.github/workflows/RUN-MIGRATION.yml`, `.github/workflows/STAGING-MIGRATE.yml`, `scripts/aws/staging-db-*.sh`, tests | `staging-db-isolation` |
| `kiro-aws-access` | vitana-platform | `infra/kiro-access/**`, `.github/workflows/AWS-KIRO-ACCESS.yml`, `docs/KIRO-AWS-ACCESS.md` | none |

Lanes that change a protected gate file (`rules-platform`, `rules-v1`, `machine-gate-protected`, `quarantine`,
`pipeline-b-platform`) are `executor: claude` with no fixed seat, as `queue.mjs` requires today; while Claude Code is
unavailable they go to the exceptions path (`collaboration.md` §7) and any Kiro seat may build them.

Hot files sequenced: `CLAUDE.md` (only `rules-platform`), `PR-GATE.yml` (only `pipeline-b-platform`),
`collaboration.md` (only `rules-platform`). Protected gate files are touched by `rules-platform`,
`machine-gate-protected`, `quarantine`, `pipeline-b-platform` — each merges under the current §3a rule with this plan's
owner instruction plus a reviewer-agent accept; after `machine-gate-protected` lands, later ones use the two-model rule.

## 5. Tests (each red on base first)
- `machine-gate-protected`: `gate-invariants.mjs` fails when any invariant is removed (mutation fixtures);
  `GATE-INVARIANTS.yml` runs on push to `main` (asserted by a workflow-trigger unit test); land-guard refuses a protected file with one accept, merges with two accepts from
  different chain models on the current head; queue scope-check accepts a protected file for a Kiro lane only with
  `protected_gate: two-model` from a trusted source; governance.ts mirrors it.
- `quarantine`: plan-spar escalation writes `state: quarantined`, `next_actor: kiro` and emits the OASIS event; plan-driver `next` lists a
  re-plan action for a quarantined lane and keeps independent lanes; quarantine is never `done`.
- `pipeline-b-*`: allowed/denied fixtures per surface; VTID-ALLOCATE dry-run on a fixture PR allocates exactly once
  and refuses a non-qualifying diff.
- `staging-db-isolation`: the guard fails on each production identifier in a fixture config, a fixture workflow YAML
  and a fixture task-definition template (including `vitana/aurora/prod/postgrest-authenticator-uri`); provisioning workflow
  `--plan` mode prints no production ARN.
- `staging-migrations-auto`: target `staging` never resolves to a production cluster, project ref or
  `AWS_PROD_ROLE_ARN`; `staging-db-apply-migration.sh` without `--cluster`, or with `--cluster vitana-aurora-prod`, fails; rollback path
  covered with a failing fixture migration on a local Postgres.
- `kiro-aws-access`: policy unit test: every production ARN in the pinned list is denied in `kiro-staging-operator`, the boundary blocks `iam:*` on the role itself, and the GitLab delete denies are present in `kiro-engineering-admin`.
STAGING-VERIFY on each merge commit that deploys; `docs/validation/<VTID>/staging-tests.json` per lane.

## 6. Risks
- Self-modifying gates: mitigated by the two-model rule and every check green; the change history is in git.
- Staging data plane cost (Aurora cluster): one small serverless v2 cluster, min capacity 0.5 ACU.
- Removing the escalation stop for security findings: quarantine keeps the work out of `main` until a re-plan passes
  sparring; nothing is reported verified.
- Admin role in the engineering account: scoped to `841276716213`; production in `472838866351` stays denied.
<!-- plan:end -->
