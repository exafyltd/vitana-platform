---
slug: agentic-delivery
author: kiro
author_seat: exafy
executor: kiro
next_actor: kiro
state: drafted
spar_refs:
  - exafyltd/vitana-v1: 7829ef2f2ef12364862961d339161229c286d6f0
updated: 2026-11-04T20:55Z
---
# Handoff — agentic-delivery
Milestone 3 of program `engineering-platform`: the agent-native delivery process on our own GitLab, vitana-v1 first,
supervised in the Command Hub, with the VTID ledger and OASIS as the record of all work. Plan: `plan.md`. Lanes:
`lanes/*.md` (wave 1 only). Per-file workflow list: `inventory.md` (generated; `plan.md` §2.2 binds).

## Log

### 2026-11-04T20:55Z · kiro-exafy-202611041929-802c · drafted
Owner, 2026-11-04: *"The whole exercise installing GitLab is because GitHub is the bottleneck and I can't take it no
more."* *"We must get prepared for running dozens of agents in parallel, for continuous deployment and continuous
integration."* *"we only pay for aws instances. no license fees to GitLab or others."* Also: use the Command Hub to
manage continuous development and supervise the system, and keep the VTID ledger and OASIS as the single source of truth
for all development history. Pushed as a `plan(` PR for CI PLAN-SPAR. No code before VTIDs.

Decisions taken:
1. This session runs as seat `exafy` (the sandbox does not show the account; `exafy` owns the platform area in
   `docs/programs/areas.yaml`). All six lanes are seat `exafy`, vitana-platform only, reviewer agent.
2. Wave 1 leaves vitana-v1's production paths on GitHub, dispatch only: PUBLISH's frontend leg, the edge-function deploys
   and the 21 `apply-*` migrations. PUBLISH and every `AWS-PROD-*` file are untouched (protected); they move in wave 2.
3. Plans for vitana-v1 work keep living in vitana-platform during wave 1, so PLAN-SPAR is unchanged until wave 2.
4. Cross-repo review entries are read from the platform lane file through the GitLab mirror. Trust stays trailer-based,
   as today (plan R1); a reviewer service with its own identity is wave 3.
5. The signed-in part of vitana-v1's `preview-e2e` moves from merge-request time to STAGING-VERIFY, because an agent
   branch never sees a secret (plan §3.4, R8). No spec is dropped.
6. STAGING-VERIFY keeps `record-oasis.sh` unchanged, so the PUBLISH gate reads the same rows; the key it needs comes from
   Secrets Manager into a deploy-class job that runs no repository code (plan §7).
7. New delivery facts reach OASIS only through the signed GitLab webhook route; `autopilot-event-mapper.ts` is untouched
   in wave 1 (plan §3.11). The Project Manager needs no change: it cannot merge a GitLab URL (`decide.ts:139-142`).
8. vitana-v1's code is not changed in wave 1. Its GitHub workflows are disabled by the owner's cutover script, not
   deleted; the protected `PR-GATE.yml` and `AWS-PROD-DEPLOY-FRONTEND.yml` stay as files.

Assumptions to verify first (each read-only):
- M1's mirror copies every branch of vitana-platform, including `kiro/*` (the review source of plan §3.5 needs it; with
  only `main`, a cross-repo lane lands after its records PR merges).
- GitLab 19.5 pipeline webhooks carry `commit.message` and the `builds` list (needed for `delivery.landed` and the
  staging deploy events).
- The M2 settings sync copies every `infra/gitlab-engineering/ci/*.yml` file, so the new `tpl-*.yml` files need no change
  to the sync.
- Rootless BuildKit runs on the M2 job image with seccomp and AppArmor unconfined (plan R4; the fallback is Buildah).
- The fixture of the last 60 merged vitana-v1 PRs can be read with read-only `gh api` calls.

What to check first: the first PLAN-SPAR round. Likely topics: the move of signed-in preview specs (R8), the service-role
key in the `record` job, trailer-based cross-repo review (R1), cross-plan starts on M2 files (plan §9), and the AWS
claim limit for a self-managed GitLab (plan §7). VTIDs come only from CI PLAN-SPAR.

Ready for pickup by kiro-exafy-202611021438-cff7. The `_plan` claim is released when this entry is pushed, so that
session can claim `agentic-delivery/_plan` and drive the plan.
