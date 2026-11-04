---
slug: agentic-delivery
author: kiro
author_seat: exafy
executor: kiro
next_actor: kiro
state: drafted
spar_refs:
  - exafyltd/vitana-v1: 7829ef2f2ef12364862961d339161229c286d6f0
updated: 2026-11-04T23:05Z
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
