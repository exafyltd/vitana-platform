---
slug: sparring-floor-retry
author: kiro
author_seat: exafy
executor: claude
next_actor: claude
state: approved
updated: 2026-10-19T18:45Z
sparring_record: .kiro/specs/sparring-floor-retry/sparring/verdict.md
vtids: [VTID-05240]
---
# Handoff — sparring-floor-retry

Makes a round-1 `evidence_floor_not_met` escalation (partner made 0 `read_file` calls, from the broken
code-read token) retryable in both the gateway dedup and `plan-spar.mjs`, including a migration for existing
`state.json` entries. That unblocks the 10 mt-* plans whose re-pushes at 18:42–18:45Z were no-ops.

Plan: `plan.md`. Requirements, design and tasks are alongside.

Lanes:
- `floor-retry-code`: executor **claude** (governance path `scripts/collab/**`), reviewer `exafy`.

## Log

### 2026-10-18T19:30Z · kiro-exafy-202610181845-661d · drafted
Authored from the code (`plan-spar.mjs` step() retry logic, `plan-sparring-service.ts` RETRYABLE_REASONS
dedup, `partner.ts` floor emission) and the evidence: PLAN-SPAR runs 39155415959…39155608288 green with
"nothing to commit". Pushed as a plan( PR for PLAN-SPAR. No VTID allocated by this session.
Sonnet 4.6 fallback is confirmed live on staging (CloudWatch `/vitana/gateway`, round 1 and 2 turns).

### 2026-10-18T20:05Z · kiro-exafy-202610181845-661d · drafted (round 1 answered)
Accepted R1-F1…F4. I read all 10 stranded sessions (GET only): every round-1 tool_log had 0 successful reads, between
2026-10-17T18:39Z and 18:44Z, and every reason is evidence_floor_not_met. So the plan now keys on "every code read
failed" (relabel as code_access_unavailable, plus a one-time legacy reclassification) rather than making the floor
reason retryable in general.

### 2026-10-18T19:57Z · ci-plan-spar · escalated (partner unavailable)
The sparring partner could not review (model_unavailable). Not a plan problem: Claude Code looks at the partner, then re-runs.

### 2026-10-18T22:06Z · kiro-exafy-202610182201-a62f · drafted (round 2 is an infra escalation, not findings)
Answered the Planner (A) item for round 2. `round-2.md` is a partner-outage infra escalation, not a
plan-critique round: the partner (Claude Opus 4.6 on Bedrock) returned
`model_unavailable: Bedrock invoke_failed: Too many tokens per day`, and the round has zero findings.
`sparring/state.json` has `verdict: escalated`, `infra: true`, `retryable: true`, `submitted: [1]`.
Wrote `sparring/responses-2.md` with an empty `[]` disposition array and a note explaining why — there
is nothing to accept/reject/defer, so no `plan.md` change (plan hash preserved for a clean re-spar).
This is a Claude Code / CI re-run concern per CLAUDE.md rule 53 (no silent fallback; a failed partner
call is retried) and collaboration §7 (Claude Code handles partner outages). Mechanically,
`plan-spar.mjs` `step()` takes the `retryInfra` path on the next push (pops the escalated session,
creates a fresh one) and never reads `responses-2.md`; a responses file is only consumed on the
`in_progress` branch. Left `next_actor: claude`, `state: drafted` unchanged — the partner-outage retry
belongs to Claude Code / PLAN-SPAR, not to the plan author. No VTID, no live write, no merge; nothing
outside this one item.

### 2026-10-18T22:12Z · ci-plan-spar · escalated (partner unavailable)
The sparring partner could not review (model_unavailable). Not a plan problem: Claude Code looks at the partner, then re-runs.

### 2026-10-19T17:30Z · kiro-exafy-202610181845-661d · drafted (re-spar after the daily-limit outage)
Session 798679a9 escalated `model_unavailable` (Opus and Sonnet both hit the daily limit). That is an infra outage
and is retryable. Pushing again now that the DeepSeek last-resort tier (#4192) is live on staging and production
(4e0e7d1f).

### 2026-10-19T18:25Z · kiro-exafy-202610181845-661d · drafted (re-plan, session 2)
Session 12379be3 hit the round cap with R3-F1 (the `reclassified` marker was not persisted on the nothing_to_do
path) and R3-F2 (the migration gate excluded legacy `partner_output_invalid` entries, which are infra:true). Both
are fixed in the plan text: state.json is written on the non-matching path, and the gate is `retryable === false`
only. This push starts session 2, the last.

### 2026-10-19T18:31Z · ci-plan-spar · drafted → approved
Converged; approved by policy converged-auto-v1. 1 lane(s) got a VTID and are handed to Kiro.

### 2026-10-19T18:45Z · kiro-exafy-202610181845-661d · approved (handed to Claude Code)
Converged in session 2 round 2 (3b3d1387, plan hash d7ba69f7…), VTID-05240. The lane `floor-retry-code` is
`executor: claude` (governance path `scripts/collab/**`). PLAN-SPAR set its `next_actor: kiro` because
`plan-spar.mjs` hardcodes `kiro` on allocation, whatever the lane's `executor`. Claude Code builds this lane; Kiro
does not. (That hardcoding is itself a bug for the next `plan-spar.mjs` change: set `next_actor` from the lane's
`executor`.)

Three minor findings from the converging round, which don't block. Please handle them in the implementation and
mention them in the PR:
- R2-F1: also check `codeAccessFailed` before the `deadline_exceeded` return (partner.ts ~L129). A hanging-fetch
  outage is still retryable there, but gets the wrong label.
- R2-F2: the legacy cutoff. All 10 stranded sessions were created 2026-10-17 18:37–18:45Z, and the first session
  that read code successfully after the fix (mt-guardrails, e7f1e151) was created 2026-10-18T18:18:23Z. Use
  `created_at < 2026-10-18T18:18:23Z` (evidence-based) instead of 12:00Z.
- R2-F3: the turn-cap exit is partner.ts L250, not ~L253.

After merge and the staging deploy: push once on each of the 10 stranded mt-* plans (author seat hotmail). Each
should get a new session id with the session count unchanged.

### 2026-10-22T17:04Z · kiro-exafy-202610221701-0923 · driver wake-up (automation, item W)
Fallback wake-up (`.kiro/automations/exafy.md`, plan kiro-autonomy-fallback VTID-05271). Took over a stale driver
heartbeat (prior `kiro-exafy-202610221601-80c3`, >45 min old) and wrote a fresh one on
`refs/heads/collab-driver/sparring-floor-retry`; hold the `_plan` claim. Resumed from git: plan converged and
approved by policy `converged-auto-v1` (verdict.md, state.json session 3b3d1387, plan hash d7ba69f7…), VTID-05240;
plan PR already merged (only open PR is the pm-agent bookkeeping #4249); no open sparring round; no lane PR; no
in-review lane. `plan-driver.mjs next` returns exactly one action: build `floor-retry-code`. That lane is
`executor: claude` and a governance path (`scripts/collab/**`, incl. the protected gate file
`scripts/collab/plan-spar.mjs`), so an automation-started driver may not build it (driver.md "Automation-started
driver"; collaboration.md §7a) — it waits for Claude Code, or the exceptions seat `exafyltd` if Claude goes
unavailable under the §7 4h rule. No other action is open to this driver. Keeping the driver heartbeat live was the
wake-up's purpose; no code changed, no VTID allocated, no merge, no live-system write. Next wake-up resumes from git.
