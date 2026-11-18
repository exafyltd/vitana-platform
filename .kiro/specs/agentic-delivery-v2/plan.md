---
change_class: standard
---
# plan(agentic-delivery-v2): one delivery flow for 13 parallel executors, on autopilot to STAGING-VERIFY

Author: Kiro, seat `exafyltd`, session `kiro-exafyltd-202611111044-8f1d` (Kiro Web), 2026-11-11. Premises read at
vitana-platform `6dc6e1ba0c` and vitana-v1 `e31bf4627` (both `origin/main`). It builds on the approved plans
`agentic-delivery` (11 of 14 lanes on `main`; `cutover` and `cut-settings` not built), `eng-gitlab-m1` and
`eng-gitlab-m2`, and keeps what they built: the generated GitLab pipelines, the merge bot and its train, the runner
classes, the GitHub bridge and STAGING-VERIFY. Companion plan: `privacy-ledger-auth` (seat-file privacy, production
ledger auth). Executors are named by seat only; no account address appears in this plan.

Owner, 2026-11-10 (Kiro Web): *"we have 12 Kiro accounts that in parallel deliver and one Claude Code account ... the
delivery pipeline is end-to-end to verified staging without human in the loop ... The first moment when the human in
the loop should be allowed or should be triggered is after staging verified."* *"the flow is stopping at each small
gate asking for a fresh VTID ... when we have simple front-end work, picking up a fresh VTID, making a stamp in Oasis
should be a piece of cake, but it should not go to sparring."* *"no credentials, no access to AWS, no access to ...
Cloudflare ... should be stored in one place, so that when one account of the 12 Kiro accounts starts the process,
that it's not each time asking for the tokens."* Owner decisions of 2026-11-11 (D1–D12) are in §2.

<!-- plan:begin -->
Privacy rule for this plan and its sparring (owner spec v5): no plan text, finding, response or record quotes an email
address; cite `file:line` instead.

## 0. Premises (each one file on `main`; vitana-platform unless marked v1)
1. Kiro may take a VTID only from PLAN-SPAR: `.kiro/pipeline/common-rules.md` rule 6; `.kiro/steering/vitana-pipeline.md:18`.
   PLAN-SPAR runs only on PRs that change `.kiro/specs/*/plan.md` or a responses file (`.github/workflows/PLAN-SPAR.yml:22-28`).
   Rule 51a (`CLAUDE.md:338-343`) gives a frontend-simple change "a fresh VTID from the ledger" with no sparring, but
   names no CI path that a Kiro session may use.
2. The class check exists and only reports: v1 `scripts/ci/pr-gate/lib.mjs:244` (`frontendSimpleViolations`; class
   constants `:223-238`), called by `gate.mjs:63-85`. PR-GATE step "Sparring record" runs with `continue-on-error`
   (v1 `.github/workflows/PR-GATE.yml:103-106`); the Verdict step exits 1 only when `scripts/ci/pr-gate/config.json`
   has `enforce: true` (`PR-GATE.yml:182-190`); it is `false` since 2026-10-07. v1 `main` has no required status
   checks (branch protection: empty list, enforcement off; no rulesets).
3. CI already allocates outside PLAN-SPAR: `.github/workflows/VTID-ALLOCATE.yml:36,58` (`POST /api/v1/vtid/allocate`
   with `GATEWAY_SERVICE_TOKEN`). The route: `services/gateway/src/routes/vtid.ts:144` (`requireLedgerWriteAuth`).
4. GitLab today (`infra/gitlab-engineering/settings/gitlab-settings.json`): `vitana-platform` and `vitana-v1` are
   `profile: mirror`, `landing: false`, `required_jobs: []`, CI files `platform.gitlab-ci.yml` / `v1.gitlab-ci.yml`
   (milestone-1 pipelines); `agent-kiro-{exafy,exafyltd,jtadic,hotmail}` and `agent-reviewer` are members of `rehearsal`
   only. The merge bot is a custom Free-tier train (`scripts/eng/gitlab-land.mjs:1-3`).
5. Mirror pipeline job `gateway-jest` (`infra/gitlab-engineering/ci/platform.gitlab-ci.yml:55-64`): `parallel: 4`,
   `npx jest --silent --maxWorkers=2 --shard=$CI_NODE_INDEX/$CI_NODE_TOTAL`.
6. Reviewer: `.kiro/agents/vitana-lane-reviewer.md` (Kiro-hosted models; self-review rule; a protected gate file is a
   blocking finding). Merge authority lists the reviewer models in `services/gateway/src/services/project-manager/governance.ts`
   (`REVIEWER_AGENT_MODELS`), mirrored in `scripts/ci/kiro-steering/guard.cjs`.
7. Sparring chain: `services/gateway/src/constants/llm-defaults.ts:115,128,149` (`eu.anthropic.claude-opus-4-6-v1`,
   `eu.anthropic.claude-sonnet-4-6`, `deepseek-v4-pro`); the DeepSeek tier calls `https://api.deepseek.com/chat/completions`
   (`services/gateway/src/services/llm-router.ts:879`). At most 2 PLAN-SPAR sessions run at once
   (`scripts/ci/plan-spar-slot/slot.mjs:22`).
8. Seats: `docs/programs/areas.yaml:14-18` (four seats); `scripts/collab/queue.mjs:65` (`SEAT_RE = /^[a-z]{1,12}$/`).
9. Runner fleet: `infra/gitlab-engineering/RUNBOOK.md` §1 (AWS account `vitana-engineering`, region `eu-central-1`; the
   owner works from CloudShell in the management account); `infra/gitlab-engineering/terraform/fleet.tf:9-17,48-49,92-110`
   (untrusted class at most 24 machines of 4 vCPUs; quota precondition);
   `infra/gitlab-engineering/terraform/fleet-classes.tf:18-47` (main 12, deploy 6, build 4; reserved 398 On-Demand and
   384 Spot vCPUs).
10. Staging shares the production database: `CLAUDE.md` rule 48 (Staging Verification Gate).

## 1. Goal
Any of 13 executors (12 Kiro seats, 1 Claude Code seat) takes a task and carries it to "staging verified" with no human
question on the way. Every gate before staging is answered by a machine and recorded in OASIS: class, VTID, plan,
sparring, tests, review, visual and audio checks, landing, deploy, verification. The one human message is Gate 2,
*"Staging verified — ready for deployment to production?"*. PUBLISH stays the owner's command. A simple front-end change
gets its VTID in seconds on GitLab after the cut (until then by today's `VTID-ALLOCATE.yml`; nothing new is built on
GitHub, §6.1), skips sparring, and goes from first push to staging verified in about 30 minutes of pipeline time.

## 2. Owner decisions (2026-11-11, final) and where they land
| # | Decision | In this plan |
|---|---|---|
| D1 | A separate test database for write flows and the live voice test: an Aurora clone made by `AWS-REHEARSAL-AURORA-CLONE`, not a Supabase project (owner answer 2026-11-11). Until it exists those checks stay BLOCKED, and Gate 2 says so | §13.3; Wave 2 lane `test-database` |
| D2 | Only additive migrations are automatic, after a dry run on an Aurora copy; everything else waits for Gate 2 | §18; Wave 2 lane `migration-autoapply`. Until it lands, `collaboration.md` §7d applies unchanged |
| D3 | Protected files: two Bedrock reviews, no owner sign-off | `review-service` (class P needs two accepts), `rules-platform`, `rules-v1`. Until they land §3a applies; the owner's instruction naming this plan covers this plan's own protected files |
| D4 | Keep DeepSeek as the last tier of the sparring and review chains | §14.3 (conflict D13) |
| D5 | Bedrock region: EU only | §14.1: `eu.` geo profiles from `eu-central-1` |
| D6 | Claude Code reaches GitLab through the GitHub bridge until it can push directly | bridge kept (lane `github-bridge` of `agentic-delivery`, done) |
| D7 | Seats: keep `exafy`, `exafyltd`, `jtadic`, `hotmail`; add 8 for Kiro 4–11; names only | lanes `seats`, `gitlab-accounts` |
| D8 | A dispatcher replaces the hourly wake-ups | Wave 2 lanes `dispatch`, `runner-launch` |
| D11 | Phase 0 starts immediately | §17 |
| D12 | Opus 5.5 and Sonnet 5.5 for the delivery stages; Opus 4.6 and Sonnet 4.6 when 5.5 is not available on quota; record the model that served each call. Sonnet 5.5 adopted (owner, 2026-11-11). The owner spec `agentic-delivery-scope` v5 §4 fixes the chain per gate: sparring M1, review M4, vision M5 | §11, §12, §13.2, §14; quota in §14.1 |
| D14 | The bridge is the GitHub-kept list of `agentic-delivery` §2.2. Nothing else stays on GitHub; nothing new is built on GitHub (owner, 2026-11-11) | §6.1 (bridge table); lanes `vtid-on-pr`, `review-workflow`, `review-dispatch-v1` withdrawn |
| D9 | Undefined: no file available to Kiro defines it (owner spec v5 §3). Nothing in this plan depends on it; the token lifetime stays as configured | §10 |
| D10 | Undefined, as D9 (v5 §3). Nothing in this plan depends on it; the approved hard cut stays | §19.3 |
| D13 | DeepSeek is a config option, default off: A = DeepSeek V3.2 on Bedrock in `eu-north-1`, B = `api.deepseek.com`, C = no DeepSeek tier. A DeepSeek tier is used only when the config also records its endpoint's location (v5 §3) | §14.3 |
| D15 | The Aurora cutover date is set jointly by the owner and Claude Code from migration progress, as soon as possible; Kiro reports the progress data and never sets the date | §9.1; progress table in `handoff.md` |
| D16 | No new code calls Supabase directly: no new Supabase REST, RPC or client call and no new Supabase project (Supabase is being shut down). Every database write goes through a gateway API (ALWAYS 25); the database target comes from one config value | §9.1 |

## 3. Corrections to the previous draft
| # | Item | Correct statement and evidence |
|---|---|---|
| C1 | `frontendSimpleViolations` location and effect | v1 `scripts/ci/pr-gate/lib.mjs:244`, not `:217` (`:217` is the comment header). It **only reports**: premise 2. A diff that breaks the class shows a warning in the PR-GATE summary and still merges. |
| C2 | Pipeline 229 (vitana/vitana-platform, job `gateway-jest` 4/4, job 1084) | **The job log is still unread**: this session's GitLab connection answers 403 and no GitLab read credential exists for it (prerequisite P5 of v5 §6; §17 P4). The owner spec v5 W4 names commit `611e93c3ca` (VTID-05672, branch `ccr-0a1941aa-54w7ly`, not on `main`). The command of premise 5, run locally on 2026-11-11: at `611e93c3ca` 440 suites, 1 failed; 6,306 tests, 1 failed, 4 skipped. The failing test is `services/gateway/test/vtid-04715-staging-verify-deployed-commit.test.ts:76` (*never defines SHA at job level*): that branch's `STAGING-VERIFY.yml` (commit `6229cd5333`) no longer has `EVENT_SHA:` in the job `env` block the test reads. At `6dc6e1ba0c` (commit of 2026-11-08): 443 suites, 6,506 tests, 0 failed, 4 skipped. If pipeline 229 ran `611e93c3ca`, this is its failure; that link is confirmed only by `GET /api/v4/projects/2/jobs/1084/trace`. |
| C3 | "63% of `main` commits are bookkeeping" | Reproduced on a full, non-shallow clone of `exafyltd/vitana-platform`, fetched 2026-11-11 10:43 UTC, `origin/main` = `6dc6e1ba0c18252ec2f3fbf5651d245e200f9835`: 396 of 625 first-parent commits between 2026-10-11 and 2026-11-10 touch only `.kiro/specs/`, `docs/validation/` or `docs/programs/` (63.4%). Command in §4. A count of 10 of 38 does not come from this history (704 commits in the window without `--first-parent`); it fits a shallow clone or another repository's history, such as the GitLab copy. |
| C4 | "Kiro Web pushes directly to GitLab" | **Open assumption A1, unverified.** Kiro's documentation describes a GitLab integration for instances reachable from the internet ([Kiro: GitLab](https://kiro.dev/docs/web/gitlab/)), and `gitlab.vitanaland.com` is internet-facing (`terraform/main.tf:225-227,528`), but this session's GitLab connection answers 403 for both projects. **The GitHub bridge stays for every seat until A1 is verified** (Phase 0 P5). |
| C5 | Seat names | Keep `exafy`, `exafyltd`, `jtadic`, `hotmail` (no renames). Add `delta`, `echo`, `foxtrot`, `golf`, `hotel`, `india`, `juliet`, `kilo` (letters only, at most 12, `SEAT_RE`). Claude Code is seat `claude` (executor `claude`). |
| C6 | AWS account for the runner vCPU quota | The fleet runs in the `vitana-engineering` account (premise 9), not in `472838866351`. A quota raised in `472838866351` does not reach the runners. |
| C7 | Sonnet 5.5 in the EU | The previous draft said it launched on the global profile only. AWS now lists `eu.anthropic.claude-sonnet-5-5` (§14.1). |
| C8 | DeepSeek | It is not on the delivery path's Bedrock: the tier calls DeepSeek's own API (premise 7), and DeepSeek states that it collects, processes and stores personal data in the People's Republic of China ([privacy policy](https://cdn.deepseek.com/policies/en-US/deepseek-privacy-policy.html)). D13. |
| C9 | Account addresses | More than `areas.yaml`: 69 platform files and 45 v1 files on `main`, and the author or committer field of 3,802 platform and 1,567 v1 commits. Companion plan `privacy-ledger-auth` (lane `areas-emails`, `history-rewrite-proposal.md`). |
| C10 | "The reviewer refuses `executor: claude` lanes" | No such rule (premise 6); `executor: claude` lanes `pipelines` and `merge-queue` were accepted. |
| C11 | "Platform merge-request pipelines are running" | Those are the milestone-1 mirror pipelines; the delivery pipelines run on no real project yet (premise 4). |

## 4. Why the flow stops today (measured)
1. **No allowed VTID path for Kiro outside a plan** (premise 1). The rule files contradict each other on this 12 times,
   and IF–THEN 9 ("prefer stricter rule") turns each contradiction into a stop.
2. **Credentials arrive by five routes and none is central.** Claude Code uses account connectors and pasted env vars;
   Kiro Web has only its GitHub connection (the proxy refuses GraphQL and `gh variable get`); CI uses 37 stored secret
   names across both repositories; the gateway uses task roles; some steps are owner console work. All seats and the
   Project Manager share one GitHub user's API quota (55 v1 job failures in 14 days, `.kiro/specs/pm-ci-load/plan.md:28-32`).
3. **Every hand-off waits for a live session.** Sparring waits for the planner's responses file; review needs a second
   session; automation-started drivers never merge; the Project Manager is off. Per lane (12 `timings.json` files):
   review median 0.48 h, p90 19.8 h; accept to merged median 1.04 h, p90 2.6 h; plan PR to VTIDs median about 31 min.
4. **State lives in git commits.** 63.4% of `main` commits in 30 days are bookkeeping (C3); each takes the single merge
   slot and puts every open PR behind `main`. Command:
   ```bash
   git -C vitana-platform log origin/main --first-parent --since=2026-10-11T00:00:00Z --until=2026-11-10T00:00:00Z \
     --format=%H > fp.txt
   book=0; while read -r h; do f=$(git -C vitana-platform diff --name-only "$h^1" "$h")
     if [ -n "$f" ] && ! printf '%s\n' "$f" | grep -qvE '^(\.kiro/specs/|docs/validation/|docs/programs/)'; then
       book=$((book+1)); fi; done < fp.txt; echo "$(wc -l < fp.txt) $book"     # 625 396
   ```
5. **Timers instead of events**: heartbeats every 15 min, takeover after 45 min, stale lanes after 2 h or 24 h, hourly
   seat wake-ups, PLAN-SPAR slot waits up to 90 min.
6. **Bedrock quota shared with production**: PLAN-SPAR capped at 2 (premise 7).
7. **Staging shares the production database** (premise 10): write flows and a live voice round trip cannot be verified
   on staging.
8. **CI capacity**: on GitHub a v1 job waited p50 11.1 min for a runner to run 1.8 min (`agentic-delivery` §2.1); the
   GitLab fleet is set to 5 machines with no warm machine.
9. **Gates that only warn** (premise 2). An autopilot cannot rely on a warning.

## 5. Principles
1. Agents write code and tests; the pipeline does the rest. A seat holds one credential (its Git host connection).
2. Git holds content; the VTID ledger and OASIS hold state.
3. Every gate is a machine: deterministic checks block and fail closed; judgement gates (sparring, review, visual,
   audio) are Bedrock calls whose verdicts are recorded with the model that answered.
4. Events, not polling: webhooks and workflow events drive the steps.
5. One writer per fact.
6. Modules build in parallel; only real hot keys are sequenced; the merge train tests the combined tree.
7. The fast path is the default: the class is computed from the diff, and only work that needs a plan gets one.
8. One human message, Gate 2; any stop parks one item and never the rest.

## 6. Target design, in two stages
**Before the cut (GitHub, now):** nothing new is built on GitHub (D14). Wave 1 builds the pieces both hosts use, in the
gateway and in shared scripts:
- the review service and its Bedrock role (lanes `review-service`, `delivery-bedrock`, `reviewer-identity`); until the
  GitLab review job exists, lane PRs are reviewed by the reviewer agent as today;
- the sparring responder inside `plan-spar.mjs`, whose answers PLAN-SPAR's existing commit step commits
  (`PLAN-SPAR.yml:102-115`, `git add .kiro/specs`) (lane `spar-responder`). The lane keeps `PLAN-SPAR.yml` in its
  paths and changes it only if calling the responder needs a workflow step; that file is a protected gate file, and the
  lane is protected already (`plan-spar.mjs`, `plan-sparring/**`), so it is class P (two reviews, D3) either way and a
  workflow change is named in its PR;
- the change classes, the GitLab accounts and the merge-request VTID handler for the cut (lanes `change-classes`,
  `gitlab-accounts`, `gitlab-mr-vtid`).

A frontend-simple PR keeps today's path (`VTID-ALLOCATE.yml`) until the cut.

**After the cut (GitLab):** the same functions as GitLab events.
- The delivery service in the gateway (`routes/internal-gitlab-webhook.ts`, signed webhooks, VTID-05541) classifies a
  new merge request, allocates its VTID and writes it into the title (lane `gitlab-mr-vtid`).
- The review verdict becomes a commit status instead of a commit (Wave 2 `state-out-of-git`).
- A dispatcher assigns work to free seats and starts their sessions (Wave 2 `dispatch`, `runner-launch`).

| Component | Runs where | Status |
|---|---|---|
| Seats (12 Kiro, 1 Claude Code) | Kiro Web cloud sessions; Claude Code cloud | 7 Kiro accounts and Claude Code active; 5 placeholders |
| VTID-ON-PR (GitHub) | — | withdrawn (D14) |
| Review service | gateway `POST /api/v1/delivery/review` | new (Wave 1) |
| Bedrock delivery stages | role in `vitana-engineering`, assumed by the gateway | new (Wave 1 `delivery-bedrock`) |
| Delivery service (GitLab) | gateway webhook route | route and event mapper on `main`; handlers new |
| GitLab CI, merge bot, train, STAGING-VERIFY on GitLab | engineering account | built, shadow or dormant (`agentic-delivery`) |
| Secrets | AWS Secrets Manager and OIDC roles | roles scripted (`scripts/aws/setup-gitlab-oidc.sh`), not applied |

### 6.1 The bridge: what stays on GitHub (D14, owner 2026-11-11)
The bridge is the "kept" rows of `agentic-delivery` §2.2 (`.kiro/specs/agentic-delivery/plan.md:102-112`) and nothing
else. After the cut nothing else stays on GitHub, and nothing new is built on GitHub. GitLab jobs are named as
`scripts/eng/pipeline-gen.mjs` and `config/delivery/services.json` render them on `main` (`a9a36a8e1d`). The generator
has no T5 or T6 template today (`pipeline-gen.mjs:19`, header `:426`), so most kept workflows have no GitLab job yet and
stay on GitHub until a later plan (`agentic-delivery` §8.5) builds and verifies it.

| Repo | Workflows (`.github/workflows/*.yml`) | GitLab job that replaces it | Cut step | Owner | Rollback |
|---|---|---|---|---|---|
| v1 | `i18n-translate`, `i18n-audit-llm`, `i18n-long-words`, `WHATS-NEW-DRAFT` | none yet (template T7; v1 `assist_rules` has only `i18n-propagate` and `i18n-nightly`, `services.json:603-631`) | kept at the cut (cut step 4 disables only the disable list); after cut step 1 they are dispatched on a branch, because GitHub `main` takes pushes only from the mirror; retired by a §8.5 step 2 plan once the T7 job is verified | any seat (no area in `docs/programs/areas.yaml` covers `.github/workflows/**`) | the cut does not touch them (§8.4); after a move, re-enable the GitHub file, which stays until the owner deletes it |
| v1 | `SCREENS-CATALOG-TRIGGER` | `notify-platform` (`pipeline-gen.mjs:210`; `services.json:802`), active once `DELIVERY_MODE=live` | kept; retired when `notify-platform` is verified live | any seat | as above |
| v1 | `AWS-PROD-DEPLOY-FRONTEND`, `DEPLOY` | none yet (T5) | kept, dispatch only (PUBLISH); `DEPLOY`'s push path stays frozen by `cutover_gate`; §8.5 step 2 | owner (`AWS-PROD-*.yml` is protected; the plan calls `DEPLOY` protected, but no glob matches it) | PUBLISH dispatches the GitHub files until T5 is verified |
| v1 | `supabase-functions-deploy`, `SUPABASE-FUNCTIONS-RETIRE`, and 21 `apply-<x>-migration` (x = comment-reactions-replies, cumulative-like-notifications, feed-video-interactions, fix-community-notify-name-fallback, july-19-kira-ticket-price, live-stream-interested-list, live-subscribers, localize-post-interaction-notifications, mentions, notify-name-fallback-full-name, notify-on-community-publish, notify-on-post-mention, post-interaction-notifications, post-notification-deeplink, vtid-03319-phase2, vtid-04916-event-share-posts, vtid-04955-group-participants, vtid-04960-thread-join-hardening, vtid-05126-calendar-entry-share, vtid-05133-ai-discoverable, vtid-05206-community-intro-opt-in) | none: they target Supabase, which is being shut down, and retire with it; Aurora migrations run through `RUN-MIGRATION` with `target=aurora` | kept, dispatch only (§7d) until the Supabase shutdown | owner (§7d) | untouched |
| platform | `PLAN-SPAR` | `plan-spar` twin (planned, `agentic-delivery` plan.md:431; `services.json:2855` has `jobs: []`) | kept for plan PRs; §8.5 step 1 starts the twin; retired on the owner's instruction naming a plan | owner (protected) | untouched |
| platform | `AWS-PROD-DEPLOY-AUTOPILOT-EXECUTOR`, `-GATEWAY`, `-KIRO-RUNNER`, `-OASIS-OPERATOR`, `-OASIS-PROJECTOR`, `-ORB-AGENT`, `-POSTGREST-AURORA-PROXY`, `-REALTIME-AURORA`, `-VERIFICATION-ENGINE`; `VISUAL-VERIFY-FRONTEND` | none yet (T5) | kept, dispatch only (PUBLISH); §8.5 step 2 | owner (protected `AWS-PROD-*`); `VISUAL-VERIFY-FRONTEND`: any seat | PUBLISH dispatches the GitHub files until T5 is verified; the gateway keeps its own automatic rollback |
| platform | `AWS-PROD-SETUP-POSTGREST-AURORA-PROXY-EDGE`, `AWS-PROD-SETUP-SCHEDULED-EDGE-CALLS` | none yet (T6) | kept, dispatch only; §8.5 step 2 | owner (protected) | untouched |
| platform | `RUN-MIGRATION`, `AWS-PROVISION-APPILIX-SECRETS`, `AWS-PROVISION-DEV-MEMORY-PACK-TOKEN`, `AWS-OPS-ECS-SCALE-UNGOVERNED`, `AWS-REHEARSAL-AURORA-CLONE`, `AWS-STAGING-VALIDATION`, `SET-STAGING-TENANT-CONSENT`, `SETUP-OPERATOR-MEDIA-BUCKET`, `JOURNEY-TRANSLATIONS-BACKFILL`, `BOOTSTRAP-CLOUDFLARE-KV`, `ANDROID-DEVICE-E2E`, `MOBILE-DEVICE-E2E`, `E2E-TEST-RUN`, `OPS-TOGGLE-FLOW-V3-STAGING` | none yet (T6; `RUN-MIGRATION` becomes one owner-dispatched T6 job, `agentic-delivery` plan.md:442) | kept, dispatch only; migrations keep §7d; §8.5 step 2 | owner for `RUN-MIGRATION` (§7d) and the clone (D15); the rest: any seat | untouched |
| platform | `ALERT-APP-USERS-IDENTITY-DRIFT`, `ALERT-NEWDAY-BRIEFING-LOOP`, `ALERT-OASIS-LEDGER-INTEGRITY`, `ALERT-ORB-BOOTSTRAP-LATENCY`, `ALERT-ORB-SESSION-STATE-HEALTH`, `ALERT-PUSH-DISPATCH-HEALTH`, `ALERT-WELCOME-GREETING-HEALTH`, `CRON-AUTO-PROMOTER`, `CRON-GRADUATION-RECOMMENDER`, `CRON-SHADOW-COMPARISON-REPORT`, `E2E-ORB-MONITOR`, `MORNING-SYSTEM-HEALTH-CHECK`, `SCREEN-LOAD-DAILY`, `SCREEN-LOAD-TIMING`, `EXERCISE-STAGING-SHADOW`, `EXERCISE-STAGING-SHADOW-CORPUS`, `MARKETPLACE-SYNC-CRON`, `DEV-AUTOPILOT`, `VCAOP-HEALTH`, `TENANT-RESERVED-SLUGS-DRIFT`, `SMOKE-WELCOME-GREETING`, `CI-HEALTH`, `DAILY-STATUS-UPDATE`, `TEST-CATALOG`, `CODEINTEL-INDEX`, `DRIVER-WAKE`, `I18N-DB-SEED`, `APPLY-FB061-DEBOUNCER-FIX`, `MIGRATION-DRIFT-CHECK` | none yet (T6; `MIGRATION-DRIFT-CHECK`: `services.json:2859`, `jobs: []`) | kept (schedules and dispatch); `MIGRATION-DRIFT-CHECK` stays path-filtered on PRs; §8.5 step 2 | any seat | untouched; the cut's rollback also lifts the Dev Autopilot pause |
| platform | `REGEN-SCREENS-CATALOG` | none yet (T7; platform `assist_rules` is empty, `services.json:2421`) | kept; its PRs go through the bridge | any seat | untouched |
| platform | `REUSABLE-NOTIFY` | stays (called by other workflows; no job planned) | stays | any seat | — |
| platform | `DEPLOY-CLOUDFLARE-WORKERS` | none: `agentic-delivery` owner decision C2 | kept; deploys production Workers on the mirror's push of `cloudflare/**` | owner (C2) | none stated while C2 is open |

89 files: 59 of 116 in vitana-platform, 30 of 46 in vitana-v1. Lane `cutover` (`agentic-delivery`, PR #4725) gives each
of them `action: keep` in `scripts/eng/github-workflows.json`. Nothing is added to this table without the owner's
answer.

What follows from D14:
- Not on the list, so disabled at the cut: `VTID-ALLOCATE.yml` and `MT-LOCAL-STACK.yml`. Both are newer than lane
  `cutover`'s list, which must classify them before the cut (its completeness test fails on an unclassified file).
- Nothing new on GitHub: lanes `vtid-on-pr` (`VTID-ON-PR.yml`), `review-workflow` (`REVIEW-BEDROCK.yml`) and
  `review-dispatch-v1` (`REVIEW-BEDROCK-DISPATCH.yml`) are withdrawn. Their functions arrive on GitLab: the merge-request
  VTID through `gitlab-mr-vtid`, the review as a merge-request pipeline job that a late lane adds after this re-plan
  converges. `spar-responder` changes no workflow file.
- Until the cut, a frontend-simple PR gets its VTID as it does today (`VTID-ALLOCATE.yml`); the fast path arrives with
  the cut.

## 7. Work classes
| Class | Mechanical test on the diff (a declared class can only be raised) | Plan and sparring | Review |
|---|---|---|---|
| A1 frontend-simple | v1 `frontendSimpleViolations` returns nothing (premise 2) | no | Sonnet 5.5 (code and screenshots) |
| A2 docs/tests-only | only docs outside governance paths, and test files | no | Sonnet 5.5 |
| B standard | everything else that is not P | yes | Opus 5.5 |
| P protected | a file of `scripts/collab/protected-gate-files.json`, LLM routing, auth, a deploy path, a non-additive migration | yes | two accepts: Opus 5.5 and Sonnet 5.5 (D3) |

One rule file, `config/delivery/change-classes.json` (lane `change-classes`), holds the lists; the v1 class lists are
copied from `lib.mjs:223-238` and a test pins the copy. A diff that outgrows its class is moved up a class, and the
author is asked for a plan; nothing dead-ends.

**Before the cut only A1 has a CI path without a plan** (VTID-ON-PR, vitana-v1). Class A2 and the classes table as a
whole take effect on GitLab when `gitlab-mr-vtid` lands; until then a docs- or tests-only change goes through a `plan(`
PR as today (R1-F1).

## 8. The flow
### Class A
| Step | Who | What | Record | Target |
|---|---|---|---|---|
| 1 | seat | branch from `main`, first commit, PR or MR (draft) | host event | 1 min |
| 2 | delivery service (GitLab); until the cut `VTID-ALLOCATE.yml` | classify; allocate; ledger `in_progress`/`approved`; title becomes `VTID-xxxxx: …`; one note | ledger row; `vtid.allocated` | GitLab: < 10 s |
| 3 | seat | code, tests, `docs/validation/<VTID>/` evidence and staging spec | pushes | agent time |
| 4 | CI | checks of the changed paths, preview build, screenshots (Wave 2), governance gates | check runs | 5–10 min |
| 5 | GitLab review job (late lane, §6.1); until then the reviewer agent | Bedrock review on the green head → commit status | `delivery.review.verdict` | 2–5 min |
| 6 | seat (fix loop) | findings or red checks go back to the seat; at most 3 rounds per failure | `delivery.fix.requested` | — |
| 7 | merge (PM rule §7b on GitHub; train on GitLab) | land | `delivery.landed` | 5–15 min |
| 8 | deploy and STAGING-VERIFY | staging deploy per service; read-only verify on the deployed commit | `staging.deploy.*`, `staging.verify.*` | 10–20 min |
| 9 | close and Gate 2 | VTID closed; one Gate 2 per release | `vtid.lifecycle.completed`, `delivery.gate2.sent` | — |

### Class B and P add, before step 1
`plan(` PR → spar to convergence (§11) → policy approval `converged-auto-v1` → lane VTIDs from PLAN-SPAR → lanes to free
seats, two lanes with the same hot key never at once.

**Gate 2 content:** the VTIDs, the verified commit, every commit between production and it, test counts, visual and voice
results with each gap and its reason (D1: write flows and the live voice test BLOCKED until the Aurora clone and its test instance exist),
protected files changed, migrations applied and pending (D2), the model that served each review and sparring call
(D12), OASIS links, decisions taken.

## 9. VTID and OASIS: one rule
> Every change gets a VTID. Sessions never allocate one. CI allocates it: PLAN-SPAR for planned work (classes B and P);
> the delivery service when a merge request opens on GitLab after the cut; until the cut, `VTID-ALLOCATE.yml` as today.
> A session that needs its VTID opens its draft PR or MR and reads the title.

- **VTID-ON-PR: withdrawn** (D14, nothing new is built on GitHub). On GitLab the delivery service does its job.
- **VTID-ALLOCATE.yml is retired at the cut** (lane `retire-vtid-allocate`, after the cut; R1-F2). It is not on the
  bridge list, so the cut disables it, and the lane deletes it once `gitlab-mr-vtid` serves frontend-simple merge
  requests. Until the cut it stays the frontend-simple path, for Claude Code like every other seat. It allocates for any
  caller with dispatch rights and checks no class; `rules-platform` removes it from the rule texts.
- **Delivery service (lane `gitlab-mr-vtid`):** the same steps on the GitLab `merge_request` `open` event, with the
  `bot-delivery` account (lane `gitlab-accounts`) for title, labels and the note; idempotent per project and MR;
  emits `vtid.allocated` with class, MR and seat. In the rehearsal project allocations carry `is_test = true`.
- **Database gate:** the `vtid_ledger` trigger stays in `log` mode, which records `missing` for allocations without a
  sparring record. Before anyone moves it to `enforce`, it needs an accepted outcome for classifier-attested
  allocations (Wave 2 `ledger-gate-attest`, a protected migration).
- **Production allocate auth:** companion plan `privacy-ledger-auth`, lane `ledger-auth-enforce`; the flip is the
  owner's command.
- **OASIS:** after the cut every step writes its event with its VTID and a `dedupe_key` (`agentic-delivery` §3.11).

### 9.1 Database target (D16, owner 2026-11-11)
- No new code in this plan calls Supabase directly: no new Supabase REST, RPC or client call, no new Supabase project.
  Every database write it adds goes through a gateway API (ALWAYS 25) with `GATEWAY_SERVICE_TOKEN`.
- **The one config value.** A pipeline step names only the gateway: repository variable `PLAN_SPAR_GATEWAY_URL`, read as
  env `GATEWAY_URL` (default `https://preview-aws-gateway.vitanaland.com`; `PLAN-SPAR.yml:92`, `VTID-ALLOCATE.yml:36`).
  The database behind the gateway is its task definition's `SUPABASE_URL`, which only the deploy input `data_backend`
  changes (`scripts/aws/taskdef-data-backend.py`, "the one place"; `AWS-STAGE-DEPLOY-GATEWAY.yml:1357-1372`,
  `AWS-PROD-DEPLOY-GATEWAY.yml:1182-1214`). At the Aurora cut (D15) the pipeline's writes move with the gateway, and no
  pipeline file changes.
- **VTID allocation** is `POST /api/v1/vtid/allocate` (`routes/vtid.ts:144`, `requireLedgerWriteAuth`) for every
  allocator: PLAN-SPAR (`plan-spar.mjs:185-188`), `VTID-ALLOCATE.yml:55-61` until the cut, and the delivery service
  (`gitlab-mr-vtid`), which calls the route with `serviceAuthHeaders()` (`middleware/ledger-write-auth.ts`) instead of
  calling `allocate_global_vtid` in-process. The ledger state (`in_progress`/`approved`) is set through
  `PATCH /api/v1/oasis/tasks/:id` (`routes/oasis-tasks.ts:332`). The route reaches the database through `SUPABASE_URL`
  (`vtid.ts:185-198`), so it follows the switch.
- **Every database write in this plan today:**

| Write | Path today | Target key |
|---|---|---|
| lane VTIDs (PLAN-SPAR) | gateway `POST /api/v1/vtid/allocate` | `PLAN_SPAR_GATEWAY_URL` |
| sparring sessions and rounds | gateway `/api/v1/plans/spar` and `/:id/rounds` (`routes/plans-spar.ts:46,56`) | `PLAN_SPAR_GATEWAY_URL` |
| frontend-simple VTID until the cut | `VTID-ALLOCATE.yml` → gateway allocate | `PLAN_SPAR_GATEWAY_URL` |
| merge-request VTID and ledger state (`gitlab-mr-vtid`) | gateway calls its own allocate and tasks routes | the gateway's `SUPABASE_URL` |
| review verdict (`review-service`) | review entry or commit status (no database); OASIS `delivery.review.verdict` through the gateway's `emitOasisEvent` | the gateway's `SUPABASE_URL` |
| STAGING-VERIFY OASIS (`record-oasis.sh`) and the deploy steps (`software_versions`, `oasis_events`) | **direct REST, no gateway** (`record-oasis.sh:63-65`; `AWS-STAGE-DEPLOY-GATEWAY.yml:1466-1495`; `AWS-PROD-DEPLOY-GATEWAY.yml:1750-1787`) | `vars.DATA_REST_URL \|\| secrets.SUPABASE_URL` |
| VTID close (`VTID-AUTO-CLOSE.yml`) | completion route of the production gateway (`vtid-auto-close.cjs:135` default) | `https://gateway.vitanaland.com` |
| `vtid_ledger` gate log | database trigger (`plan_sparring_shadow_log`) | — |
| claims, heartbeats, lane files, `timings.json` | git only | — |

  The direct writers are existing pieces reused as built (§13.4). They add a second key that has to flip with the
  gateway at the Aurora cut (`DATA_REST_URL`). Moving them behind the gateway's OASIS route (`POST /api/v1/oasis/events`,
  `routes/events.ts:480`) is a late lane with its own sparring.

## 10. Credentials: one place, one connection per seat
"One place" is AWS Secrets Manager: the engineering account for delivery secrets, the main account for application
secrets. Only pipeline jobs (OIDC roles) and the gateway (task role) read it. Seats never do.

| Actor | Holds | Set where |
|---|---|---|
| Kiro seat | its Git host connection: GitHub today; GitLab account `agent-kiro-<seat>` once A1 is verified | Kiro Settings → Integrations, once per account |
| Kiro seat sandbox | network allow-list "Common dependencies" plus `gitlab.vitanaland.com` | Kiro sandbox settings, once per account |
| Claude Code seat | its GitHub connection; the bridge copies `claude/*` branches to GitLab (D6) | Claude Code settings |
| CI on GitHub (until the cut) | repository secrets as today, plus `GATEWAY_SERVICE_TOKEN` in vitana-v1 | owner, once |
| GitLab jobs | short-lived STS credentials from ID tokens → `gl-*` roles → `vitana/ci/*` | `setup-gitlab-oidc.sh --apply`, owner, once |
| Gateway delivery stages | task role → role `vitana-delivery-bedrock` in `vitana-engineering` | lane `delivery-bedrock` + owner apply |
| Dispatcher (Wave 2) | one Kiro API key per seat, `vitana/engineering/kiro/seats/<seat>` | owner, once per account |

Onboarding a seat: settings PR (lanes `gitlab-accounts`, `seats`), the owner pastes the token into the Kiro integration
and sets the allow-list, and (Wave 2) stores the seat's Kiro API key. Token lifetime: the settings sync rotates account
tokens at 30 days left (`infra/gitlab-engineering/settings/README.md`), which breaks a pasted Kiro integration about
every 60 days. D9 is undefined (v5 §3), so this plan keeps the configured lifetime; a broken integration is recorded as
a missing prerequisite of that seat (§17) and the other seats continue.

## 11. Planning and sparring
- The seat that takes a task writes `plan.md`, `tasks.md` and the lane files.
- PLAN-SPAR runs the partner as today. New (lane `spar-responder`): when a round has no `responses-<n>.md` from the
  planner after a grace period (default 0 for autopilot runs), a Bedrock responder with the same read-only code tools
  answers every finding (accepted with the plan edit, rejected with `file:line`, or deferred with where it is tracked)
  and commits `responses-<n>.md` with the revised plan; the next round runs at once. Cap 3 rounds, then one re-plan
  session, then the plan is parked and the park recorded (§20).
- Models (gate M1 of v5 §4): partner and responder use one chain, Opus 4.6 → Sonnet 4.6 → DeepSeek (config, default
  off, D13). Every call records model id and tier (`model_log`, as today). A round with no tier available blocks the
  plan; the dispatcher retries it (§20).
- Concurrency: from 2 to 8 PLAN-SPAR sessions once the delivery stages run on the engineering account's own quota
  (lane `delivery-bedrock`); `slot.mjs` default cap changes with it.
- Rule 52 changes one sentence: the planner, or the delivery responder on its behalf, answers every finding.

## 12. Review
- **Engine (lane `review-service`):** the `vitana-lane-reviewer.md` checklist (scope, acceptance, tests that prove the
  change and were not weakened, governance, i18n, voice rules, screenshots) run by the tool loop of
  `services/dev-autopilot-llm-review.ts` (files read at the head, CI evidence), on Bedrock only. Model chain (gate M4
  of v5 §4), every class: Opus 5.5 → Sonnet 5.5 → Opus 4.6 → Sonnet 4.6 → DeepSeek (config, default off, D13).
  Class P (protected files, D3): two reviews, each on this chain, both must accept. A review with no tier available
  blocks the change; the dispatcher retries it (§20). Output: verdict JSON `{verdict, findings, reviewed_head, model,
  tier}` and OASIS `delivery.review.verdict`.
- **Trigger and record:** a GitLab merge-request pipeline job calls the review service on the green head and posts the
  verdict as a commit status (a late lane after this re-plan converges; the job is named by `pipeline-gen.mjs`). Lanes
  `review-workflow` and `review-dispatch-v1` are withdrawn (D14). Until the job exists, the reviewer agent reviews as
  today and writes the §3 review entry. Merge authority is unchanged except for the model names (lane
  `reviewer-identity`, protected). That reverses today's order (`governance.ts:39-43`, `guard.cjs:106`: Sonnet 5.5 →
  Opus 5.5 → Sonnet 4.5) to Opus first, as v5 M4 fixes it, and replaces the 4.5 tier by the two 4.6 tiers; a review
  costs more per call (§16).
- **Independence:** the reviewer runs under its own identity (`agent-vitana-lane-reviewer-…` session ids, the
  `agent-reviewer` account on GitLab), never as a seat.
- **Prompt injection:** diff text is data; an accept never overrides a red deterministic check; class P needs two models.
- The Kiro `vitana-lane-reviewer` agent stays available as a fallback reviewer.

## 13. Verification
### 13.1 Unit and integration
The MR pipeline runs only the checks of changed paths; the full suite runs once per landed train batch and nightly. On
GitLab these gates block and fail closed: class scope, lane scope, change suite ("no suite, no merge", rule 47),
red-green computed by CI, test weakening, migration lint. On GitHub `config.json` stays the owner's switch.

### 13.2 Visual (Wave 2 lanes `visual-capture`, `visual-baselines`, `a11y-check`, `staging-screens`, `hub-visual`)
- MR job: build the change, serve it with `vite preview`, Playwright with API fixtures recorded from staging; capture the
  changed routes (diff → screen manifest, registry, `App.tsx` routes) at 1400×900 and 390×844; run the change spec's
  interactions; German, English and Arabic (RTL); axe-core WCAG 2.2 AA (serious and critical block); artifacts saved.
- Baselines: `toHaveScreenshot` for the 20 most used screens; only the bot updates them after an accepted visual change.
- Review (gate M5 of v5 §4): the screenshots go to the review service's vision pass (spacing, alignment, clipped text,
  overflow, tap targets, the interaction's result, the design contract) on Opus 4.6 vision
  (`eu.anthropic.claude-opus-4-6-v1`). Opus 5.5 vision joins only after the probe of lane `model-probes` (plan
  `agentic-delivery-scope`) verifies it. DeepSeek never reviews images.
- STAGING-VERIFY: change specs signed in as the test user under the read-only guard, `screenshot: 'on'`, vision verdict
  in `results.json`. Command Hub the same way. Mobile (`apps/mobile`): report-only until KVM or Mac runners exist.
- Today no `toHaveScreenshot` exists, screenshots are taken only on failure, VISUAL-VERIFY-FRONTEND is dormant and
  preview-e2e only reports.

### 13.3 Audio, ORB voice (Wave 2 lanes `audio-harness`, `voice-e2e`, `voice-probes`, `test-database`)
| Level | What | Writes data |
|---|---|---|
| CI round trip | Jest harness: recorded speech frames into the websocket handler, stubbed upstream, in-memory database; transcript events, audio-ready ack, latency tracker, persona voice id | no |
| Real providers | after landing: Polly speaks the user line, the voice pipeline in a harness instance with an in-memory database, Nova Sonic or the cascade answers, Transcribe reads the reply; time to first audio, total latency, language, persona pitch (female 198–238 Hz, male 104–140 Hz, `orb/live/voice/persona-voice-gender.ts:54-55`), a Bedrock judge for meaning (VTID-03622) | no |
| Static | voice-gender tests, tool manifests, VOICE-PIPELINE-PARITY-SCANNER made blocking | no |
| Staging | read-only `/orb/health`, `/orb/nova-sonic/health`, bootstrap latency, build-info | no |
| Live round trip on staging | **BLOCKED until the Aurora clone and its test instance exist (D1)**: a spoken turn writes `chat_messages`, `user_intents`, memory and OASIS rows, and staging shares the production database | — |

**Test database (D1, lane `test-database`): an Aurora clone made by `AWS-REHEARSAL-AURORA-CLONE`.** Never a Supabase
project, never the production cluster.
- What the workflow makes (`.github/workflows/AWS-REHEARSAL-AURORA-CLONE.yml`, `scripts/aws/rehearsal-clone.sh`): a
  copy-on-write clone `vitana-aurora-rehearsal` of `vitana-aurora-prod` at its latest restorable time, with its own
  parameter group and master secret, Data API on, not publicly accessible, in production's subnet group and security
  groups. Every mutating call is guarded to the clone; `delete` is the only teardown (no lifetime limit). It has never
  run (0 runs, 2026-11-11) and uses the production deploy role (`AWS_PROD_ROLE_ARN`).
- **The clone holds production data, real members' rows included,** and is handled as production data: only registered
  test accounts act (`service_bot_accounts`, `notification_test_actors`); the rehearsal's neutralise step runs first
  (FCM tokens revoked, lifecycle rows marked notified, `docs/validation/VTID-05023/rehearsal.md:200-203`); the test
  gateway instance runs with every scheduler and outbound sender off (push, email, payments).
- How a suite reaches it: a staging-test gateway instance whose `SUPABASE_URL` points at a PostgREST proxy whose
  `PGRST_DB_URI` is the clone (`rehearsal.md:109-114, 198-199, 228-236`). Missing today: the secret
  `vitana/aurora/rehearsal/postgrest-authenticator-uri`, the overlay and proxy inputs (`rehearsal.md:328-340`), and the
  check that the deploy role may restore the clone (`rehearsal.md:377-382`).
- Kiro dispatches the workflow with `action: create` when its own pre-checks pass (input validation, guard self-test,
  account and region guard) and `action: status` shows no clone (v5 W7, lane `clone-prep` of plan
  `agentic-delivery-scope`). The Aurora cutover date stays with the owner and Claude Code (D15).
- Until the clone, its proxy and the test instance exist, the write-flow and live voice checks stay BLOCKED and Gate 2
  says so.

### 13.4 STAGING-VERIFY
Kept as built (deployed-commit check, every commit between production and the deployed commit, superseded handling,
read-only guard, record-oasis). Added in Wave 2: screenshots and the vision verdict in `results.json`, a `voice` kind for
read-only probes.

## 14. Models, regions and the DeepSeek conflict
### 14.1 Availability in the EU (D5, D12), from AWS's model cards (2026-11-11)
| Model | Profile from `eu-central-1` | EU destination Regions | Notes |
|---|---|---|---|
| Claude Opus 5.5 | `eu.anthropic.claude-opus-5-5` | Frankfurt, Stockholm, Milan, Spain, Ireland, Paris | in-Region only in London (not EU); Standard tier only; offered through inference profiles with limited model selection |
| Claude Sonnet 5.5 | `eu.anthropic.claude-sonnet-5-5` | the same six | no in-Region option; Standard tier only |
| Claude Opus 4.6 / Sonnet 4.6 (fallback) | `eu.anthropic.claude-opus-4-6-v1` / `eu.anthropic.claude-sonnet-4-6` | as configured today | premise 7 |
| DeepSeek V3.2 | in-Region `eu-north-1` (Stockholm) | Stockholm | no geo or global profile; also London |

Documented availability is not account quota: the quotas of the account that makes the calls decide whether 5.5 serves.
Sonnet 5.5 is adopted (owner, 2026-11-11). In `472838866351`, `eu-central-1`, Service Quotas lists 6,000,000 tokens per
minute for Sonnet 5.5 cross-Region (`L-94A31E46`) and global (`L-31AB82D0`) inference, the AWS defaults (read
2026-11-11); `eu.anthropic.claude-sonnet-5-5` is ACTIVE. The engineering account is not checked.
When a 5.5 call is refused for quota or access, the chain moves to 4.6 at once, and the call's record says which model
served (D12). Sources: [Opus 5.5 model card](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-anthropic-claude-opus-5-5.html),
[Sonnet 5.5 model card](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-anthropic-claude-sonnet-5-5.html),
[regional availability](https://docs.aws.amazon.com/bedrock/latest/userguide/models-region-compatibility.html).

### 14.2 Recording
Every delivery call records provider, model id, tier and latency (AI-29); review and sparring verdicts carry the model
and tier into OASIS and into Gate 2.

### 14.3 D13: DeepSeek as a config option (D4 and D5)
- Today's DeepSeek tier calls `https://api.deepseek.com` (premise 7). DeepSeek's privacy policy names a controller in
  China and states that it collects, processes and stores personal data in the People's Republic of China. Plans,
  diffs and code sent to it leave the EU.
- **Option A:** keep DeepSeek as the last tier, but call DeepSeek V3.2 on Amazon Bedrock in-Region in `eu-north-1`
  (Stockholm), from the engineering account. That keeps a DeepSeek model last (D4) and the data in the EU (D5). Cost:
  an older DeepSeek version than `deepseek-v4-pro`, and model access plus quota in `eu-north-1` (Phase 0 P2).
  Offered: `aws bedrock list-foundation-models --region eu-north-1 --by-provider deepseek` lists `deepseek.v3.2`
  (ACTIVE, ON_DEMAND, no inference profile), and `get-foundation-model-availability` answers AUTHORIZED and AVAILABLE
  in `472838866351` (2026-11-11). The session role may not invoke it (AccessDenied, 2026-11-11 15:34 UTC); the
  engineering account is not checked.
- Option B: keep `api.deepseek.com`; its data leaves the EU.
- Option C: no DeepSeek tier.
- **Decision (v5 §3): all three are config options, default off (C).** A DeepSeek tier is used only when the config
  also records its endpoint's location (lane `model-config`, plan `agentic-delivery-scope`). Until that lane lands, the
  new delivery stages (review, responder) run without a DeepSeek tier, and the existing partner chain is unchanged.

## 15. Thirteen executors in parallel without conflicts
### Hotspots (30 days unless stated)
| Hotspot | Churn | Treatment |
|---|---|---|
| bookkeeping (lane files, handoffs, `program.md`, closing records) | 63.4% of platform `main` commits | Wave 2 `state-out-of-git` moves state to OASIS |
| Project Manager bookkeeping branches | 131,173 commits on 35 `pm-agent/*` branches | stays off; the dispatcher replaces it |
| `supabase/migrations/**`, `DATABASE_SCHEMA.md`, drift baseline, `MIGRATION-QUEUE.md` | 57, 35, 16, 23 commits; 26 shared timestamp prefixes since August | hot key `db`; timestamp-collision lint; `DATABASE_SCHEMA.md` generated after landing (Wave 2) |
| v1 i18n shards and source stamps | 71 and 27 commits; I18N-PROPAGATE pushes into PR branches (445 runs) | hot key per namespace; propagation before review, never after |
| gateway registries (`index.ts`, `types/cicd.ts`, `orb/developer/domain-atlas.ts`, the stage-deploy env block) | 18, 19, 8, 9 | hot key `gateway-registry` |
| Command Hub files, ownership guard, generated symbol index | 12, 11, 10 | hot key `command-hub` |
| native parity ledger, `resolve.ts`, generated mobile paths | 36, 30, 10 | hot key `native-parity` |
| PR-gate ratchet baselines | 42 | computed from the base at CI time (Wave 2) |
| `App.tsx`, navigation registry, screen manifest | 4, 1, 10 (`App.tsx` 37 in 90 days) | hot key `routes` |
| `CLAUDE.md` and `.claude/rules/**` | 10 and 15 (platform), 15 and 11 (v1) | class P; lands alone |

### Rules
- Wave 1 keeps today's scheduler (`plan-driver.mjs`, hot keys, 6 build lanes per plan), with driver heartbeats at most
  30 minutes apart (owner, 2026-11-11), inside the 45-minute liveness window.
- Wave 2 (D8) dispatcher: one item per session, a per-seat session limit (start at 2); hot keys from lane paths (B) or
  area (A); two items with the same hot key never at once; an area is an affinity, not an ownership (the area's seat
  gets the first offer for 2 minutes); hot-key scheduling replaces "6 build lanes per plan".
- Shared interfaces land first as their own lane. Conflicts happen even between disjoint file sets (47% of textual
  conflicts in one study, [arXiv 2610.04779](https://arxiv.org/html/2610.04779v1)); the train's combined-tree test
  catches them.
- Migrations in flight: GitHub → GitLab keeps the bridge for every seat until A1 is verified; Supabase → Aurora waits on
  owner steps since 2026-10-13 (`.kiro/specs/claude-sessions-handover/sessions/aurora-cutover.md:11-16`); the pipeline
  reads `MIGRATION_TARGET` and `MIGRATION_FREEZE` and holds the `db` hot key during a freeze.

## 16. Capacity, speed and cost
- **Runners (engineering account):** demand at 13 seats × 2 sessions × 2 pushes an hour × about 8 selected jobs × 4 min
  ≈ 28 busy machines on average, about 55 at peak. The owner's quota of 96 vCPUs per class (Phase 0 P1) covers the
  untrusted class at its current maximum of 24 machines (`fleet.tf` precondition). The trusted classes at their maxima
  (main 12, build 4, deploy 6) need 88 more On-Demand vCPUs and the GitLab and runner hosts about 14; with 96 the classes
  share the quota and wait when it is full. `fleet-classes.tf`'s check, sized for 96 untrusted machines, warns below
  486 On-Demand and 440 Spot vCPUs. Keep 4 warm machines in working hours: `fleet_idle_count` is 0 today
  (`infra/gitlab-engineering/terraform/fleet.tf:19`) and is raised with the runner capacity of prerequisite P1
  (Terraform in the engineering account); until then each job waits about a minute for its machine, which the targets
  below do not include.
- **Full suite** once per landed train batch (per MR it would need about 130 machines at 40 landings an hour).
- **Bedrock:** quotas are per account and Region ([AWS quotas](https://docs.aws.amazon.com/bedrock/latest/userguide/quotas.html));
  delivery stages in the engineering account get their own. Rough cost from third-party price figures (verify with the
  AWS price list): a class B review about 0.40 USD, a class A review about 0.20 USD; 100 MRs a day about 30–60 USD.
- **Targets (typical / slowest 5%):** VTID in title on GitLab 10 s / 60 s (GitHub: one runner wait); first check result
  1 / 3 min; required checks 5 / 10 min; green to review verdict 2 / 5 min; accept to `main` 5 / 15 min; landing to
  STAGING-VERIFY result 10 / 20 min; class A first push to staging verified 30 / 60 min; class B plan PR to lane VTIDs
  10 / 20 min.

## 17. Phase 0: prerequisites, not gates (D11; v5 §6)
A work package whose prerequisite is missing fails closed and records which one; the other packages continue. Nothing
here waits for an answer. v5 §6 numbers them P1 vCPU (P1 below), P2 Bedrock quotas (P2), P3 13 GitLab accounts (P6),
P4 Kiro API keys (P7), P5 GitLab read credential (P4), P6 Aurora clone (§13.3) and P7 IAM roles (P3, and the delivery
role of lane `delivery-bedrock`).

| # | Item | What the owner does | Status 2026-11-11 |
|---|---|---|---|
| P1 | vCPU quotas, both classes, 96 | In the **`vitana-engineering`** account (switch role from `472838866351`, as `setup.sh` does), region `eu-central-1`, Service Quotas → Amazon EC2: "Running On-Demand Standard (A, C, D, H, I, M, R, T, Z) instances" (`L-1216C47A`) and "All Standard (A, C, D, H, I, M, R, T, Z) Spot Instance Requests" (`L-34B43A08`) → Request increase → 96. CLI: `aws service-quotas request-service-quota-increase --region eu-central-1 --service-code ec2 --quota-code L-1216C47A --desired-value 96` and the same for `L-34B43A08`. | prepared; not requested (no session has AWS rights, RUNBOOK §1) |
| P2 | Bedrock models and quotas, EU | In the engineering account, Bedrock console, `eu-central-1`: open Claude Opus 5.5 and Sonnet 5.5 in the model catalog and complete Anthropic's first-use form if asked; keep Opus 4.6 and Sonnet 4.6 enabled. Service Quotas → Amazon Bedrock → the cross-Region (geo) tokens-per-minute and requests-per-minute quotas for Opus 5.5 and Sonnet 5.5 → request about 1,000,000 tokens and 100 requests per minute each (8 parallel reviews of about 80,000 input tokens). If D13 = A: DeepSeek V3.2 model access and quota in `eu-north-1`. | Sonnet 5.5 available, 6,000,000 tokens per minute in `472838866351` (§14.1); engineering account unverified. Probe from the session role (2026-11-11 15:34 UTC): Sonnet 4.6 answered; Opus 5.5, Sonnet 5.5, Opus 4.6 (text and vision) and DeepSeek V3.2 AccessDenied (no identity-based policy) |
| P3 | Bedrock for parallel sparring and review, outside production | After lane `delivery-bedrock`: run `scripts/aws/setup-delivery-bedrock.sh` (dry run first, then `--apply`) in CloudShell; it creates role `vitana-delivery-bedrock` in the engineering account for the staging gateway's task role | waits for the lane |
| P4 | GitLab access for sessions | Kiro Settings → Integrations → GitLab → Connect → instance `https://gitlab.vitanaland.com` → paste the token of the seat's account from `vitana/engineering/gitlab/agents/agent-kiro-<seat>` (engineering account Secrets Manager). Today the four existing accounts are members of `vitana/rehearsal` only; reading `vitana/vitana-platform` (pipeline 229) needs an account that is a member, for example the owner's own | not connected: this session's GitLab connection answers 403, direct HTTPS asks for a credential |
| P5 | Verify A1 (Kiro Web pushes to GitLab) | With P4 done for one seat: that seat pushes a branch to `vitana/rehearsal` and opens a merge request from a Kiro Web session; recorded in this plan's handoff | open |
| P6 | GitLab accounts for 13 seats | 4 exist (`agent-kiro-exafy`, `-exafyltd`, `-jtadic`, `-hotmail`); 8 new and `bot-delivery` come from lane `gitlab-accounts` and the settings sync; Claude Code needs none (bridge, D6), but the bridge needs owner step A3 of `agentic-delivery` (its two tokens) | 4 of 12 Kiro accounts exist |
| P7 | Kiro API keys | Only for the dispatcher (Wave 2) and DRIVER-WAKE. Per Kiro account: sign in, account settings → generate an API key ([headless mode](https://kiro.dev/docs/cli/headless/)); store it as `vitana/engineering/kiro/seats/<seat>` in the engineering account | not needed before Wave 2 |
| P8 | `GATEWAY_SERVICE_TOKEN` in vitana-v1 | not needed: lane `vtid-on-pr` is withdrawn (D14) | dropped |
| P9 | Rendered pipelines in `vitana/ci-config` | `bash ~/vitana-eng/m2.sh status` in CloudShell (runs `gitlab-settings.mjs check`; exit 0 = no drift), or GitLab → `vitana/ci-config` → Repository: the 11 files of `infra/gitlab-engineering/ci/` with today's content. The code writes every `*.yml` of that folder in one commit when content differs (`scripts/eng/gitlab-settings.mjs:447-450`) | unverified from a session (no GitLab access) |
| P10 | Runner count | GitLab Admin Area → CI/CD → Runners (or `GET /api/v4/runners/all` with an admin token), and EC2 Auto Scaling groups `vitana-eng-fleet*` (desired and in service) in the engineering account | unverified from a session |
| P11 | D9 and D10 are undefined; D13 is settled as config (v5 §3) | nothing | closed |

## 18. Rule changes (each through this plan's sparring; protected files on the owner's instruction naming this plan)
1. One VTID rule (§9): platform `CLAUDE.md` (2b, 51a, IF–THEN 1, §4.1), `collaboration.md` §5, §7, §7a,
   `common-rules.md` rule 6, `vitana-pipeline.md`, `vitana-kiro-notes.md`, `driver.md`, `planning.md`, `lane-code.md`,
   both PreToolUse hooks; v1 `CLAUDE.md` (Plan Sparring Gate), its `collaboration.md` copy and steering. Lanes
   `rules-platform`, `rules-v1`.
2. Reviewer: the Bedrock review service is the reviewer agent's engine; the reviewer identity gains the Bedrock model
   names (`reviewer-identity`); `collaboration.md` §3 and §7 say so (`rules-*`).
3. Sparring responder may answer for the planner (rule 52) (`rules-platform`, `spar-responder`).
4. Protected files (D3): two Bedrock accepts, landing alone, listed at Gate 2 (`rules-*`; enforced by `review-service`
   and the merge rule). Until the lanes land, §3a applies.
5. Migrations (D2): additive ones automatic after a dry run on an Aurora copy (`AWS-REHEARSAL-AURORA-CLONE` exists),
   in a transaction, with a rollback file; everything else at Gate 2 (`rules-*` now; mechanism Wave 2). Until the
   mechanism lands, §7d and stop 1 apply.
6. Claude Code is one executor among 13 (`CLAUDE.md` says it is retired); it builds the protected-file lanes.
7. Seats by name only; areas are affinities (Wave 2).
8. Model rules (v5 §4): rule 53 keeps the sparring chain Opus 4.6 → Sonnet 4.6 with DeepSeek a config option, default
   off (M1); the review chain is Opus 5.5 → Sonnet 5.5 → Opus 4.6 → Sonnet 4.6 → DeepSeek (config, off) (M4); vision
   is Opus 4.6, Opus 5.5 once probed (M5).
9. Driver heartbeat interval: at most 30 minutes (owner, 2026-11-11); the liveness window stays 45 minutes
   (`collaboration.md` §8, `driver.md`) (`rules-platform`).
Each rule text carries the existing convention: a mechanism takes effect when the lane that builds it is on `main`; until
then the previous mechanism stays in force.

## 19. Lanes
### 19.1 Wave 1 (this plan's VTIDs; 14 lanes since round 1, 3 of them withdrawn by D14)
| Lane | Repo | Executor (seat) | Paths | depends_on |
|---|---|---|---|---|
| `vtid-on-pr` (withdrawn, D14) | vitana-v1 | kiro (exafyltd) | `.github/workflows/VTID-ON-PR.yml`, `scripts/ci/pr-gate/vtid-on-pr.mjs`, `scripts/ci/pr-gate/__tests__/vtid-on-pr.test.mjs` | — |
| `rules-platform` | vitana-platform | claude | `CLAUDE.md`, `AGENTS.md`, `.claude/rules/collaboration.md`, `.kiro/pipeline/{common-rules,driver,planning,lane-code}.md`, `.kiro/steering/{vitana-pipeline,vitana-kiro-notes,vitana-owner-autonomy}.md`, `.claude/hooks/pretooluse-plan-sparring-reminder.sh` | — |
| `rules-v1` | vitana-v1 | claude | `CLAUDE.md`, `AGENTS.md`, `.claude/rules/collaboration.md`, `.kiro/steering/{vitana-pipeline,vitana-kiro-notes,vitana-owner-autonomy}.md`, `.claude/hooks/pretooluse-plan-sparring-reminder.sh` | `rules-platform` |
| `change-classes` | vitana-platform | kiro (exafy) | `config/delivery/change-classes.json`, `scripts/eng/change-class.mjs`, `scripts/eng/change-class.test.mjs` | — |
| `gitlab-accounts` | vitana-platform | kiro (exafy) | `infra/gitlab-engineering/settings/gitlab-settings.json`, `scripts/eng/gitlab-settings.test.mjs` | — |
| `seats` | vitana-platform | kiro (exafyltd) | `docs/programs/areas.yaml`, `.kiro/automations/*.md`, `scripts/collab/automations.test.mjs` | — (waits for `privacy-ledger-auth/areas-emails`, same file) |
| `gitlab-mr-vtid` | vitana-platform | kiro (exafy) | `services/gateway/src/services/delivery/mr-vtid/**`, `services/gateway/src/routes/internal-gitlab-webhook.ts`, `services/gateway/test/delivery/mr-vtid.test.ts` | `change-classes`, `gitlab-accounts` |
| `delivery-bedrock` | vitana-platform | kiro (exafy) | `scripts/aws/setup-delivery-bedrock.sh`, `services/gateway/src/providers/bedrock.ts`, `services/gateway/test/delivery/bedrock-role.test.ts` | — |
| `review-service` | vitana-platform | kiro (exafy) | `services/gateway/src/services/delivery/review/**`, `services/gateway/src/routes/delivery-review.ts`, `services/gateway/src/index.ts`, `services/gateway/src/orb/developer/domain-atlas.ts`, `services/gateway/src/constants/llm-defaults.ts`, `services/gateway/test/delivery/review.test.ts` | `delivery-bedrock` |
| `reviewer-identity` | vitana-platform | claude | `services/gateway/src/services/project-manager/{governance,types}.ts`, `services/gateway/test/project-manager/governance.test.ts`, `scripts/ci/kiro-steering/guard.cjs`, `scripts/ci/kiro-steering/guard.test.cjs` | — |
| `review-workflow` (withdrawn, D14) | vitana-platform | kiro (exafy) | `.github/workflows/REVIEW-BEDROCK.yml`, `scripts/ci/review-bedrock/review-bedrock.mjs`, `scripts/ci/review-bedrock/review-bedrock.test.mjs` | `review-service`, `reviewer-identity` |
| `review-dispatch-v1` (withdrawn, D14) | vitana-v1 | kiro (exafyltd) | `.github/workflows/REVIEW-BEDROCK-DISPATCH.yml`, `scripts/ci/pr-gate/__tests__/review-dispatch.test.mjs` | `review-workflow` |
| `spar-responder` | vitana-platform | claude | `services/gateway/src/services/plan-sparring/**`, `scripts/collab/plan-spar.mjs`, `scripts/collab/plan-spar.test.mjs`, `.github/workflows/PLAN-SPAR.yml`, `scripts/ci/plan-spar-slot/**`, `services/gateway/test/vtid-04868-plan-sparring-*.test.ts` | `review-service`, `delivery-bedrock` |
| `retire-vtid-allocate` | vitana-platform | kiro (exafy) | `.github/workflows/VTID-ALLOCATE.yml` | after the cut: lane `cutover` of plan `agentic-delivery` done (D14). Its lane file still names the withdrawn `vtid-on-pr`; the lane's seat removes that entry in its first lane commit (`depends_on` is not a permission field, `scripts/collab/queue.mjs:1000`), and no driver starts it before `cutover` is done |

Shared and hot files: `services/gateway/src/index.ts` and `orb/developer/domain-atlas.ts` (hot key `gateway-registry`)
belong to `review-service` only; `llm-defaults.ts` belongs to `review-service` only (it also sets the partner's model
constants for `spar-responder`); `docs/programs/areas.yaml` is shared with the companion plan and sequenced after it;
`.claude/rules/collaboration.md` stays byte-identical in both repositories, so `rules-v1` lands right after
`rules-platform`. No other file is in two lanes.

Order of value: `rules-*` first; `delivery-bedrock`, `review-service`, `reviewer-identity` next (the review engine);
`spar-responder` (it ends the sparring wait; its DeepSeek tier is config, off by default, D13); `change-classes`, `gitlab-accounts`, `seats`,
`gitlab-mr-vtid` for the cut. The three withdrawn lanes are parked by their seats after this plan merges, because a
`_plan` commit cannot edit a lane file. The GitLab review job is a late lane added after the re-plan converges.

### 19.2 Wave 2 (late lanes through `_plan` after Wave 1 lands; designs in §§9–15)
`state-out-of-git`, `visual-capture`, `visual-baselines`, `a11y-check`, `staging-screens`, `hub-visual`, `audio-harness`,
`voice-e2e`, `voice-probes`, `test-database` (D1), `migration-autoapply` (D2), `dispatch` and `runner-launch` (D8),
`ledger-gate-attest`, `head-email-cleanup` (step 0 of the companion proposal).
The owner spec `agentic-delivery-scope` v5 builds part of this as its own plan of that name, which reuses the Wave 1
lanes above instead of duplicating them: its lanes `verify-visual` (for `visual-capture`, `staging-screens`),
`verify-audio` (for `audio-harness`, `voice-probes`), `clone-prep` (for `test-database`) and `dispatcher` (for
`dispatch`) replace those Wave 2 lanes here. The other Wave 2 lanes stay with this plan.

### 19.3 Relationship to `agentic-delivery`
Its lanes `cutover` and `cut-settings` stay there. `cut-settings` adds the agent and `bot-delivery` memberships of the
real projects at the cut; `cutover` must also classify `VTID-ALLOCATE.yml` and `MT-LOCAL-STACK.yml`, which its list
predates (both are disabled at the cut, D14); the three withdrawn workflows are never created. Its stale lane files (`deploy-path` and `build-class-retag-2` merged but `executing`;
`build-class-retag` superseded) are closed by its own driver; while `deploy-path` reads `executing`, its driver does not
start `cutover`.

## 20. Stops: recorded, not waited on (v5 §2)
No human is asked before Gate 2. A blocked change is retried by the dispatcher with exponential backoff, at most 6
attempts in 24 hours, then recorded as blocked (OASIS `blocked`, the lane parked with the reason); every other change
continues. A change is blocked, never carried on, when:
1. It has a security or data-loss risk.
2. It needs a production write not covered by Gate 2, including a non-additive migration (D2).
3. The same failure fingerprint survives 3 fix attempts.
4. Its sparring escalates after the re-plan session.
5. It would ship beyond the verified commit.
6. A gate it needs has no model tier available (no non-EU provider answers).
Until lane `rules-platform` lands, the stop rules of `collaboration.md` §7 apply as written.

## 21. Risks
- An LLM accept is not proof: deterministic gates block, STAGING-VERIFY binds, class P needs two models, the change
  failure rate is measured.
- Prompt injection through diffs: the diff is data; an accept never overrides a red check.
- Data residency: EU geo profiles route within six EU Regions (§14.1); the non-EU option B is off by default (D13).
- A1 unverified; Kiro API keys per plan tier unverified; the bridge stays.
- Token lifetime of Kiro integrations (§10; D9 is undefined).
- A single GitLab host; GitLab reported AWS OIDC failures after the 19.3.6, 19.4.3 and 19.5.1 updates
  ([GitLab support](https://support.gitlab.com/hc/en-us/articles/31365024559516-AWS-OIDC-authentication-with-ID-tokens-fails-after-upgrade-to-GitLab-19-3-6-19-4-3-or-19-5-1));
  the instance is pinned to 19.5.3; the deploy roles are checked in the rehearsal.
- Staging shares the production database until D1; additive migrations reach production before Gate 2 by D2.
- The D1 Aurora clone is a copy of production data, real members' rows included (§13.3).
- The size of the hard cut (159 workflow files); Aurora freeze windows during rehearsals.
- Self-modifying governance: a change to the reviewer or responder takes effect only after it lands; the previous version
  reviews it.

## 22. Measurement
`docs/validation/<plan VTID>/timings.json` (`collaboration.md` §8b), and from OASIS after the cut: the §16 targets,
landings per hour, STAGING-VERIFY pass rate, change failure rate, time to restore, cost per day, and the share of calls
served by each model tier.

## 23. Unchanged
PUBLISH and production stay the owner's. STAGING-VERIFY, its read-only guard and record-oasis stay as built. Staging
tests stay read-only until D1. The partner chain is unchanged until `spar-responder` and `model-config` land. No
migration is applied by this plan.

## 24. Sources (content rephrased for compliance with licensing restrictions)
- Kiro Web GitLab integration: https://kiro.dev/docs/web/gitlab/ — sandbox network: https://kiro.dev/docs/web/sandbox/internet-access/
- Kiro cloud sessions: https://kiro.dev/docs/guides/running-kiro-in-the-cloud/ — headless mode: https://kiro.dev/docs/cli/headless/
- Claude Code cloud sessions (GitHub only for clone and PRs): https://code.claude.com/docs/en/claude-code-on-the-web
- GitLab merge trains (Premium): https://docs.gitlab.com/ci/pipelines/merge_trains/
- Bedrock model cards and Regions: links in §14.1; quotas: https://docs.aws.amazon.com/bedrock/latest/userguide/quotas.html
- DeepSeek privacy policy: https://cdn.deepseek.com/policies/en-US/deepseek-privacy-policy.html
- Parallel agents and merge coordination: https://circleci.com/blog/parallel-coding-agents/ — conflicts with disjoint
  files: https://arxiv.org/html/2610.04779v1 — voice agent testing: https://hamming.ai/resources/voice-agent-testing-ci-cd-regression-load-security
<!-- plan:end -->
