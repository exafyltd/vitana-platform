---
slug: agentic-delivery
author: kiro
author_seat: exafy
executor: kiro
next_actor: kiro
state: approved
spar_refs:
  - exafyltd/vitana-v1: 7829ef2f2ef12364862961d339161229c286d6f0
updated: 2026-11-08T12:42Z
sparring_record: .kiro/specs/agentic-delivery/sparring/verdict.md
vtids: [VTID-05545, VTID-05546, VTID-05547, VTID-05548, VTID-05549, VTID-05550, VTID-05551, VTID-05552, VTID-05554, VTID-05562, VTID-05563, VTID-05564, VTID-05643, VTID-05671]
---
# Handoff — agentic-delivery
Milestone 3 of program `engineering-platform`: the hard cutover of delivery for both repositories to our own GitLab,
supervised in the Command Hub, with the VTID ledger and OASIS as the record of all work. Plan: `plan.md`. Lanes:
`lanes/*.md` (7, everything the cut needs).

## Log

### 2026-11-04T23:05Z · kiro-exafy-202611041929-802c · drafted
Owner, 2026-11-04: *"The whole exercise installing GitLab is because GitHub is the bottleneck and I can't take it no
more."* *"we only pay for aws instances. no license fees to GitLab or others."* Then, the same evening: *"we have no time
to waste and must migrate to gitlab away from github"* and *"we need a hard cut and move away from github ... we need a
hard cutover and move to gitlab for the delivery."* Also: the Command Hub manages continuous development and supervises
the system, and the VTID ledger and OASIS stay the single source of truth for development history.

This plan replaces the staged-waves draft (PR #4680, closed with its branch). Its one sparring round (session
`41979912-a895-4305-8fc4-dca2907d1506`) escalated with `evidence_floor_not_met`: the partner read no file and raised no
finding on the plan. The new plan starts with §0, eight premises with exact files, so the partner has them to read.
Pushed as a `plan(` PR for CI PLAN-SPAR. No code before VTIDs.

Decisions taken:
1. Hard cut for both repositories on one day, when a mechanical checklist is green (plan §8.1); target 7 days after
   approval. This replaces "vitana-v1 first" on the owner's instruction above.
2. GitHub becomes an inbox for agent branches only: the `github-bridge` copies agent branches and PRs to GitLab, and
   GitLab push-mirrors `main` back. Each branch has one writer; there is no two-way sync of any branch (plan §3.1).
   Reason: Kiro Web sessions push through a GitHub connection and may not reach our GitLab.
3. At the cut, GitHub keeps only PLAN-SPAR, the dispatch-only production and migration workflows, and the scheduled jobs
   (plan §2.2). PUBLISH, `AWS-PROD-*` and migrations are unchanged; they move after the cut.
4. The staging Project Manager is switched off at the cut and Dev Autopilot is paused (owner, kill switch); the gateway
   refuses GitHub merges with `merge_moved_to_gitlab`. Both come back on GitLab with the provider layer.
5. 7 lanes instead of 6, because the cut needs the bridge; at most 6 build at once (`collaboration.md` §8a).
6. The rest of the first draft's decisions stand: Seat `exafy`; STAGING-VERIFY and `record-oasis.sh` unchanged; delivery
   facts reach OASIS only through the signed webhook route; `autopilot-event-mapper.ts` untouched at the cut; signed-in
   preview specs move to STAGING-VERIFY (R9).

Assumptions to verify first (each read-only):
- GitLab 19.5 push mirroring of protected branches only, with divergent refs kept, behaves as documented on the Free tier.
- GitLab 19.5 pipeline webhooks carry `commit.message` and the `builds` list (needed for `delivery.landed`).
- The M2 settings sync copies every `infra/gitlab-engineering/ci/*.yml` file.
- Rootless BuildKit runs on the M2 job image with seccomp and AppArmor unconfined (plan R5; the fallback is Buildah).
- pipeline-speed PR #4674 lands before the build starts (plan §8.1 step 1).

What to check first: the first PLAN-SPAR round. Likely topics: the bridge as the one exception to "GitHub read-only"
(decision 2), the size of a one-day cut (R1), the service-role key in the `record` job, trailer-based cross-repo review
(R2), cross-plan starts on M2 files (plan §9), and the AWS claim limit for a self-managed GitLab (plan §7).

Ready for pickup by kiro-exafy-202611021438-cff7, or by whichever session answers the next round first. The `_plan`
claim is released when this entry is pushed.

### 2026-11-04T23:40Z · kiro-exafy-202611041929-802c · drafted (owner correction of the targets)
Owner, 2026-11-04: *"the plan is very good, just following correction"*: after the cut, typical / slowest 5 %, a
one-lane task 1 h / 3 h, first result 1 / 3 min, required checks 5 / 10 min, accept to merged 5 / 15 min, merged to
staging result 10 / 20 min, about 96 sessions. Plan §5 and §1 carry these numbers. To reach them the plan adds: the
merge bot's train (up to 8 tested positions per repository, plan §3.5), a warm pool of 4 machines, sharding to jobs
under 4 minutes, image layer caches, a 30-second deregistration delay on staging, the GitLab host at m6i.2xlarge, the
machine maxima 96 / 12 / 6 and a budget alarm at 5,000 USD a month. The cut waits until the shadow pipelines meet the
targets (plan §8.1). No lane file changed; the train lives in the merge-queue lane's own files.

### 2026-11-05T00:30Z · kiro-exafy-202611041929-802c · sparring round 1 answered
Round 1 (session `b80e315e-68b7-4e3b-ae79-d876722af78c`) verified eight premise groups and returned three findings,
answered in `sparring/responses-1.md`: R1-F1 (Workers deploy without PUBLISH) accepted: it stays exactly as today and is
documented as the one pre-existing exception (§3.1 principle 5, §4, a test in lane `cutover`, the cut checklist), and
moving it under PUBLISH is owner decision C2; R1-F2 (`record-oasis.sh` names the GitHub workflow) accepted: a `WORKFLOW`
input with today's default; R1-F3 (unpinned PUBLISH frontend leg) deferred to T5, with risk R12 and a mitigation on the
Delivery screen. While answering, I found a defect the round did not raise: the atlas drift guard
(`test/vtid-04560-role-separation-regression.test.ts:524-528`) fails for any new file under `services/gateway/src/routes/`
that no atlas domain claims, which hits `routes/delivery.ts` here and `routes/internal-gitlab-webhook.ts` of eng-gitlab-m2
lane `scm-webhook`. Lane files cannot be edited in a plan PR after their first commit, so a new lane `prerequisites`
(created in this commit, as a `_plan` commit may) adds both atlas claims and the `WORKFLOW` input; it lands first (§9).
Also tonight: 148 queued GitHub runs that tested superseded PR heads were cancelled (293 → 136 queued; the PM's
bookkeeping pushes refilled it to about 300 within 25 minutes); eng-gitlab-m2 lane `gitlab-client` (#4679) got its
reviewer-agent accept on `e4b294c` (the builder's runtime had no reviewer agent); the stale eng-gitlab-m2 driver
heartbeat (22:15Z) was taken over by this session.

### 2026-11-05T00:25Z · ci-plan-spar · drafted → approved
Converged; approved by policy converged-auto-v1. 8 lane(s) got a VTID and are handed to Kiro.

### 2026-11-05T00:33Z · kiro-exafy-202611041929-802c · approved (driver: merging the plan PR)
Round 2 converged with no findings (session `b80e315e`), policy approval `converged-auto-v1` at 2026-11-05T00:24:00Z, and
CI allocated VTID-05545 to VTID-05552 for the eight lanes. This entry starts the PR checks that PLAN-SPAR's own push does
not start; the plan PR merges when they are green. First lane: `prerequisites` (it lands before eng-gitlab-m2
`scm-webhook`, PR #4686, and before `gateway-delivery`). eng-gitlab-m2 lane `gitlab-client` landed as `8f3934c8` (#4679).

### 2026-11-05T05:33Z · kiro-exafy-202611041929-802c · approved (late lane `reseat`)
The Project Manager moved all eight lanes to the exceptions seat `exafyltd` at 02:53Z/02:59Z (`stale_ready`, #4688),
while the driver heartbeat was stale for 54 minutes (02:04Z to 02:58Z, a builder step that did not refresh it). Plan §9
assigns them to seat `exafy`, and Lane scope now refuses the `exafy` builders' lane-file commits once `main` is merged
into their PRs (#4690 prerequisites, accepted on `18a10349`; #4689 github-bridge, fix round 1 on `83f8b616`). Late lane
`reseat` (`lane_admin: true`, paths = the eight lane files) restores the seat through the reviewed path; PLAN-SPAR
allocates its VTID. Builds are now done by separate builder sessions of seat `exafy`, so the driver can request the
reviews (the reviewer refuses a review requested by the lane's builder). Earlier attempt #4687 (built by the driver) is
closed; #4690 replaces it.

### 2026-11-05T10:16Z · ci-plan-spar · approved (late lane VTID)
Converged; approved by policy converged-auto-v1. 1 lane(s) got a VTID and are handed to Kiro.

### 2026-11-05T10:55Z · kiro-exafy-202611041929-802c · approved (driver: merging the late-lane plan PR)
PLAN-SPAR allocated VTID-05554 to lane `reseat` at 10:16Z (late lane, no new round; the sparred text is unchanged). This
entry starts the PR checks that PLAN-SPAR's own push does not start; #4691 merges when they are green. Then a builder
session of seat `exafy` that is not the driver builds `reseat`, and the driver requests its review.

### 2026-11-05T21:35Z · kiro-exafy-202611041929-802c · approved (late lanes nav-paths, sv-cwd, cut-settings)
State at 21:30Z. On main: prerequisites (#4690, `51c2bead07`), reseat (#4703, `49cff4a9df`); eng-gitlab-m1 gitlab-infra
(#4692); eng-gitlab-m2 gitlab-client (#4679, record #4693) and monitoring (#4710). In review: github-bridge #4689 and
eng-gitlab-m2 merge-bot #4697 (accepted, the accepts still count), scm-webhook #4696, fleet #4716, settings #4711,
verify-on-gitlab #4705, deploy-path #4714 (waits for fleet), pipelines #4709 (review `changes` 16:54Z, six blocking).
merge-queue is built and parked locally (waits for merge-bot, and for settings' `loadEffectiveProjects`). gateway-delivery,
cutover and eng-gitlab-m2 rehearsal are built by `kiro-exafy-202611021438-cff7` (backups on `kiro/backup/*`), PRs when their
bases land. Driver heartbeats were stale 18:20Z-21:02Z; renewed for all three plans at 21:02Z.
Three late lanes, outside the sparred text (plan.md "Late lanes"): `nav-paths` (`lane_admin`: four files for lane
gateway-delivery, from its builder's sync), `sv-cwd` (fix forward: every gateway STAGING-VERIFY since 14:57Z fails only on the
manifests of VTID-05515, 05516, 05518, which run Jest from the repository root), `cut-settings` (settings the cut needs that no
lane builds; after cutover). Landing order the driver applies: merge-bot and github-bridge first (accepted), then sv-cwd,
fleet, settings, scm-webhook (its own diff carries a workflow file, so later updates of the others would need new reviews),
then verify-on-gitlab and pipelines (after settings), deploy-path (after fleet), merge-queue (after merge-bot and settings),
nav-paths before gateway-delivery, cutover, cut-settings.

### 2026-11-05T21:34Z · ci-plan-spar · approved (late lane VTID)
Converged; approved by policy converged-auto-v1. 3 lane(s) got a VTID and are handed to Kiro.

### 2026-11-05T21:45Z · kiro-exafy-202611041929-802c · approved (driver: merging the late-lane plan PR)
PLAN-SPAR allocated VTID-05563 (`nav-paths`), VTID-05564 (`sv-cwd`) and VTID-05562 (`cut-settings`) at 21:34Z.

### 2026-11-08T11:45Z · kiro-exafy-202611081113-5a2e · late lane added (build-class-retag)
Plan PR `plan(agentic-delivery)`, branch `kiro/agentic-delivery/plan-3`. The `_plan` claim held by `kiro-exafy-202611062222-c262` was
stale (last commit 2026-11-05 21:45Z, claim 37h old, over the 24h rule). This session broke it with `release --stale` and claimed the
plan. Added: the Late lanes note in `plan.md`, lane `build-class-retag` (`ready`), tasks group `build-class-retag`. Its VTID comes from
PLAN-SPAR. Merge gate: not before the `vitana-eng-build` class runs (owner A2 and A3). Scope note: the generator's runner tag comes from
`config.runner_tags.main` (`pipeline-gen.mjs:193`), and `config/delivery/services.json` has no build key. The lane is built inside its
listed paths with a literal build tag in the generator. A `services.json` key would need that file in the lane's paths.

### 2026-11-08T11:39Z · ci-plan-spar · approved (late lane VTID)
Converged; approved by policy converged-auto-v1. 1 lane(s) got a VTID and are handed to Kiro.

### 2026-11-08T12:42Z · ci-plan-spar · approved (late lane VTID)
Converged; approved by policy converged-auto-v1. 1 lane(s) got a VTID and are handed to Kiro.
