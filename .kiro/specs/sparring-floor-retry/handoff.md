---
slug: sparring-floor-retry
author: kiro
author_seat: exafy
executor: claude
next_actor: claude
state: approved
updated: 2026-10-22T09:03Z
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

### 2026-10-20T20:01Z · kiro-exafy-202610202001-7717 · approved (automation-started driver woke, no buildable work)
Fallback wake-up (`.kiro/automations/exafy.md`, plan `kiro-autonomy-fallback`). This plan's driver heartbeat was
`none`, and the plan is `approved` with `author_seat: exafy`, so item W applied: wrote the first heartbeat
(`73897f39…`, no other driver alive) and took the `_plan` claim (`5e65cb85…`). `plan-driver.mjs next` returns one
action, `build floor-retry-code` (VTID-05240). An **automation-started driver never builds a governance lane or an
`executor: claude` lane** (`.kiro/pipeline/driver.md` → "Automation-started driver"), and `floor-retry-code` is both
(`executor: claude`, paths under `scripts/collab/**`). No open `plan(` PR, no sparring round awaiting a response, no
`in-review` lane. So there is no action this driver may take beyond the heartbeat: the lane waits for its builder
(Claude Code) or an interactive driver. Front matter unchanged (`state: approved`, `next_actor: claude` is correct —
the lane's builder is Claude Code). No VTID allocated, no merge, no live-system write.

### 2026-10-20T22:03Z · kiro-exafy-202610202201-f154 · approved (driver heartbeat refreshed, still no buildable work)
Next fallback wake-up (`.kiro/automations/exafy.md`, item W). The 20:01Z driver's heartbeat had gone stale (`none`),
so I took it over: refreshed the heartbeat on `refs/heads/collab-driver/sparring-floor-retry` (took over
`kiro-exafy-202610202101-2af8`), released that session's stale `_plan` claim and took `_plan` as
`kiro-exafy-202610202201-f154`. State is unchanged from the 20:01Z entry: `plan-driver.mjs next` still returns only
`build floor-retry-code`, which is `executor: claude` on governance paths, so an automation-started driver may not
build it; `CLAUDE_AVAILABLE` is unreadable from Kiro Web (HTTP 403 → no override), so the lane is not reassigned to
the exceptions seat either. Driver is alive again for the next ~45 min; the lane still waits for Claude Code. No
state change, no VTID, no merge, no live write.

### 2026-10-20T23:04Z · kiro-exafy-202610202301-8f4f · approved (driver heartbeat refreshed, still no buildable work)
Next fallback wake-up (`.kiro/automations/exafy.md`, item W). The 22:03Z driver's heartbeat had gone stale (tip
`574243c8…` was ~57 min old, > 45 min), so I took it over: refreshed the heartbeat on
`refs/heads/collab-driver/sparring-floor-retry` (`aa8605a8…`, took over `kiro-exafy-202610202201-f154`) and took the
`_plan` claim (`8dafe605…`) as `kiro-exafy-202610202301-8f4f`. Resumed from git: `plan(` PR #4186 is merged (spec on
`origin/main`), VTID-05240 allocated, no open plan PR, no sparring round awaiting a response, no `in-review` lane.
`plan-driver.mjs next` still returns only `build floor-retry-code`, which is `executor: claude` on governance paths
(`scripts/collab/**`, incl. the protected gate file `scripts/collab/plan-spar.mjs`); an automation-started driver may
not build a governance or `executor: claude` lane (`.kiro/pipeline/driver.md` → "Automation-started driver";
automation file Wake-a-driver point 3). `CLAUDE_AVAILABLE` is still unreadable from Kiro Web (HTTP 403 → no override),
so no reassignment to the exceptions seat. The lane waits for Claude Code or an interactive driver. Front matter
unchanged. No VTID, no merge, no live-system write. Releasing the `_plan` claim on stop; the next wake-up resumes.

### 2026-10-21T00:05Z · kiro-exafy-202610210001-0dcc · approved (automation driver resume, no buildable work)
Automation wake-up (seat exafy, `.kiro/automations/exafy.md`), fallback item W. The driver heartbeat was `none`
(stale), so I took over `refs/heads/collab-driver/sparring-floor-retry` (`4e5384f1…`, took over from
`kiro-exafy-202610202301-8f4f`) and took the `_plan` claim (`c2033b21…`). Resumed from git: `plan(` PR is merged
(spec on `origin/main`), VTID-05240 allocated, no open plan PR, no sparring round awaiting a response, nothing
`in-review`, nothing to land. `plan-driver.mjs next` still returns only `build floor-retry-code`, which is
`executor: claude` on governance paths `scripts/collab/**` (incl. the protected gate file `scripts/collab/plan-spar.mjs`);
an automation-started driver may not build a governance or `executor: claude` lane (`.kiro/pipeline/driver.md` →
"Automation-started driver"; automation file Wake-a-driver point 3; collaboration.md §7a). `CLAUDE_AVAILABLE` is still
unreadable from Kiro Web (HTTP 403 → no override), so no reassignment to the exceptions seat `exafyltd`; and this lane
would never route to `exafy`. The lane waits for Claude Code or an interactive/exceptions driver. Front matter
unchanged in meaning. No VTID, no merge, no live-system write. Releasing the `_plan` claim on stop; the next wake-up
resumes from git.

### 2026-10-21T01:00Z · kiro-exafy-202610210100-118b · approved (automation driver resume, no buildable work)
Automation wake-up (seat exafy, `.kiro/automations/exafy.md`), fallback item W. The driver heartbeat was `none`
(stale), so I took over `refs/heads/collab-driver/sparring-floor-retry` (`29bbdf0c…`, took over from
`kiro-exafy-202610210001-0dcc`) and took the `_plan` claim (`09572439…`). Resumed from git: `plan(` PR #4186 is
merged (spec on `origin/main`), VTID-05240 allocated, no open plan PR, no sparring round awaiting a response,
nothing `in-review`, nothing to land. `plan-driver.mjs next` still returns only `build floor-retry-code`, which is
`executor: claude` on governance paths `scripts/collab/**` (incl. the protected gate file
`scripts/collab/plan-spar.mjs`); an automation-started driver may not build a governance or `executor: claude` lane
(`.kiro/pipeline/driver.md` → "Automation-started driver"; automation file Wake-a-driver point 3; collaboration.md
§7a). `CLAUDE_AVAILABLE` is still unreadable from Kiro Web (HTTP 403 → no override), so no reassignment to the
exceptions seat `exafyltd`; and this lane would never route to `exafy`. The lane waits for Claude Code or an
interactive/exceptions driver. Front matter unchanged. No VTID, no merge, no live-system write. Releasing the
`_plan` claim on stop; the next wake-up resumes from git.

### 2026-10-21T03:03Z · kiro-exafy-202610210301-66d7 · approved (automation driver resume, no buildable work)
Automation wake-up (seat exafy, `.kiro/automations/exafy.md`), fallback item W. The driver heartbeat was `none`
(stale), so I took over `refs/heads/collab-driver/sparring-floor-retry` (`45a504507…`, took over from
`kiro-exafy-202610210201-f90f`) and took the `_plan` claim (`e5494dd9…`). Resumed from git: `plan(` PR #4186 is
merged (spec on `origin/main`), VTID-05240 allocated, no open plan PR, no sparring round awaiting a response (both
sparring sessions are terminal in `state.json`; session 2 converged and is policy-approved `converged-auto-v1`),
nothing `in-review`, nothing to land. `plan-driver.mjs next` still returns only `build floor-retry-code`, which is
`executor: claude` on governance paths `scripts/collab/**` (incl. the protected gate file `scripts/collab/plan-spar.mjs`);
an automation-started driver may not build a governance or `executor: claude` lane (`.kiro/pipeline/driver.md` →
"Automation-started driver"; automation file Wake-a-driver point 3; collaboration.md §7a). `CLAUDE_AVAILABLE` is still
unreadable from Kiro Web (HTTP 403 → no override), so no reassignment to the exceptions seat `exafyltd`; and this lane
would never route to `exafy`. The lane waits for Claude Code or an interactive/exceptions driver. Front matter
unchanged. No VTID, no merge, no live-system write. Releasing the `_plan` claim on stop; the next wake-up resumes
from git.

### 2026-10-21T04:04Z · kiro-exafy-202610210401-6704 · approved (automation driver resume, no buildable work)
Automation wake-up (seat exafy, `.kiro/automations/exafy.md`), fallback item W. The driver heartbeat was stale
(~57 min), so I took over `refs/heads/collab-driver/sparring-floor-retry` (`99d25fff…`, took over from
`kiro-exafy-202610210301-66d7`) and took the `_plan` claim (`106d2de7…`). Resumed from git: `plan(` PR #4186 is
merged (spec on `origin/main`), VTID-05240 allocated, no open plan PR, no sparring round awaiting a response (both
sparring sessions terminal in `state.json`; session 2 converged and is policy-approved `converged-auto-v1`), nothing
`in-review`, nothing to land. `plan-driver.mjs next` still returns only `build floor-retry-code`, which is
`executor: claude` on governance paths `scripts/collab/**` (incl. the protected gate file `scripts/collab/plan-spar.mjs`);
an automation-started driver may not build a governance or `executor: claude` lane (`.kiro/pipeline/driver.md` →
"Automation-started driver"; automation file Wake-a-driver point 3; collaboration.md §7a). `CLAUDE_AVAILABLE` is still
unreadable from Kiro Web (HTTP 403 → no override), so no reassignment to the exceptions seat `exafyltd`; and this lane
would never route to `exafy`. The lane waits for Claude Code or an interactive/exceptions driver. Front matter
unchanged (next_actor stays `claude`). No VTID, no merge, no live-system write. Releasing the `_plan` claim on stop;
the next wake-up resumes from git.

### 2026-10-21T07:01Z · kiro-exafy-202610210701-ead8 · approved (automation driver resume, no buildable work)
Automation wake-up (seat exafy, `.kiro/automations/exafy.md`), fallback item W. The driver heartbeat was `none`
(stale), so I took over `refs/heads/collab-driver/sparring-floor-retry` (`4434f517…`, took over from
`kiro-exafy-202610210601-9d77`) and took the `_plan` claim (`d6492ded…`). Resumed from git: `plan(` PR #4186 is
merged (spec on `origin/main`), VTID-05240 allocated, no open plan PR, no sparring round awaiting a response (both
sparring sessions terminal in `state.json`; session 2 converged and is policy-approved `converged-auto-v1`), nothing
`in-review`, nothing to land. `plan-driver.mjs next` still returns only `build floor-retry-code`, which is
`executor: claude` on governance paths `scripts/collab/**` (incl. the protected gate file `scripts/collab/plan-spar.mjs`);
an automation-started driver may not build a governance or `executor: claude` lane (`.kiro/pipeline/driver.md` →
"Automation-started driver"; automation file Wake-a-driver point 3; collaboration.md §7a). `CLAUDE_AVAILABLE` is still
unreadable from Kiro Web (HTTP 403 → no override), so no reassignment to the exceptions seat `exafyltd`; and this lane
would never route to `exafy`. The lane waits for Claude Code or an interactive/exceptions driver. Front matter
unchanged (next_actor stays `claude`). No VTID, no merge, no live-system write. Releasing the `_plan` claim on stop;
the next wake-up resumes from git.

### 2026-10-21T09:04Z · kiro-exafy-202610210902-47c9 · approved (automation driver resume, no buildable work)
Automation wake-up (seat exafy, `.kiro/automations/exafy.md`), fallback item W. The driver heartbeat was `none`
(stale), so I took over `refs/heads/collab-driver/sparring-floor-retry` (`7fa3b0ce…`, took over from
`kiro-exafy-202610210801-688e`) and took the `_plan` claim (`58df8767…`). Resumed from git: `plan(` PR #4186 is
merged (spec on `origin/main`), VTID-05240 allocated, no open plan PR, no sparring round awaiting a response (both
sparring sessions terminal in `state.json`; session 2 converged and is policy-approved `converged-auto-v1`), nothing
`in-review`, nothing to land. `plan-driver.mjs next` still returns only `build floor-retry-code`, which is
`executor: claude` on governance paths `scripts/collab/**` (incl. the protected gate file `scripts/collab/plan-spar.mjs`);
an automation-started driver may not build a governance or `executor: claude` lane (`.kiro/pipeline/driver.md` →
"Automation-started driver"; automation file Wake-a-driver point 3; collaboration.md §7a). `CLAUDE_AVAILABLE` is still
unreadable from Kiro Web (HTTP 403 → no override), so no reassignment to the exceptions seat `exafyltd`; and this lane
would never route to `exafy`. The lane waits for Claude Code or an interactive/exceptions driver. Front matter
unchanged (next_actor stays `claude`). No VTID, no merge, no live-system write. Releasing the `_plan` claim on stop;
the next wake-up resumes from git.

### 2026-10-21T10:03Z · kiro-exafy-202610211001-d784 · approved (automation driver resume, no buildable work)
Automation wake-up (seat exafy, `.kiro/automations/exafy.md`), fallback item W. The driver heartbeat tip
(`kiro-exafy-202610210902-47c9`, 2026-10-21T09:06Z) was ~56 min old (> 45 min, `heartbeat-age` 3378090 ms), so I
took it over (`62624dfe…`) and took the `_plan` claim (`522304e4…`) as `kiro-exafy-202610211001-d784`. Resumed from
git: `plan(` PR merged (spec on `origin/main`), VTID-05240 allocated, no open plan PR, no sparring round awaiting a
response (all rounds answered; `s2-round-2` converged, policy-approved `converged-auto-v1`), nothing `in-review`,
nothing to land. `plan-driver.mjs next` still returns only `build floor-retry-code`, which is `executor: claude`,
`seat: claude` on governance paths `scripts/collab/**` and `services/gateway/src/services/plan-sparring/**` (incl. the
protected gate file `scripts/collab/plan-spar.mjs`); an automation-started driver may not build a governance or
`executor: claude` lane (`.kiro/pipeline/driver.md` → "Automation-started driver"; automation file Wake-a-driver point
3; collaboration.md §7a). The live queue now shows `floor-retry-code` with `seat: exafyltd` on branch
`origin/pm-agent/sparring-floor-retry` (updated 2026-10-21T10:01Z by `pm-agent`), i.e. the exceptions seat has picked
it up. `CLAUDE_AVAILABLE` unreadable from Kiro Web (HTTP 403 → no override). Front matter unchanged (next_actor stays
`claude`). No VTID, no merge, no dispatch, no live-system write. Releasing the `_plan` claim on stop; the next wake-up
resumes from git.

### 2026-10-21T11:03Z · kiro-exafy-202610211101-0868 · approved (automation driver resume, no buildable work)
Automation wake-up (seat exafy, `.kiro/automations/exafy.md`), fallback item W. The 10:03Z driver's heartbeat tip
(`kiro-exafy-202610211001-d784`, 2026-10-21T10:06Z) was 56 min old (> 45 min), so I took it over
(`964d1797…`) and took the `_plan` claim (`2b48ccf7…`) as `kiro-exafy-202610211101-0868`. Resumed from git:
`plan(` PR #4186 merged (spec on `origin/main`), VTID-05240 allocated, no open plan PR, no sparring round awaiting a
response (session 2 converged, policy-approved `converged-auto-v1`), nothing `in-review`, nothing to land.
`plan-driver.mjs next` still returns only `build floor-retry-code`, which is `executor: claude` on governance paths
`scripts/collab/**` and `services/gateway/src/services/plan-sparring/**` (incl. the protected gate file
`scripts/collab/plan-spar.mjs`); an automation-started driver may not build a governance or `executor: claude` lane
(`.kiro/pipeline/driver.md` → "Automation-started driver"; automation file Wake-a-driver point 3; collaboration.md
§7a). The live queue shows `floor-retry-code` now `seat: exafyltd` on branch `origin/pm-agent/sparring-floor-retry`
(updated 2026-10-21T11:03Z by `pm-agent`), i.e. the exceptions seat still holds it. `CLAUDE_AVAILABLE` unreadable
from Kiro Web (HTTP 403 → no override). Front matter unchanged except `updated` (next_actor stays `claude`). No VTID,
no merge, no dispatch, no live-system write. Releasing the `_plan` claim on stop; the next wake-up resumes from git.

### 2026-10-21T14:01Z · kiro-exafy-202610211401-7038 · approved (automation driver resume, no buildable work)
Automation wake-up (seat exafy, `.kiro/automations/exafy.md`), fallback item W. This plan is `approved`,
`author_seat: exafy`, and its driver was not alive — the 13:01Z tip (`kiro-exafy-202610211301-4b89`) was ~57.7 min
old (3459845 ms > 45 min) — so item W applied. Took it over: refreshed the heartbeat on
`refs/heads/collab-driver/sparring-floor-retry` (`97b61eb5…`) and took the `_plan` claim (`b7a8382f…`) as
`kiro-exafy-202610211401-7038`. Resumed from git: `plan(` PR #4186 merged (spec on `origin/main`), VTID-05240
allocated, no open plan PR, no sparring round awaiting a response, nothing `in-review`, nothing to land (and an
automation-started driver never merges). `plan-driver.mjs next` still returns only `build floor-retry-code`, which is
`executor: claude` on governance paths `scripts/collab/**` and `services/gateway/src/services/plan-sparring/**`
(incl. the protected gate file `scripts/collab/plan-spar.mjs`); an automation-started driver may not build a
governance or `executor: claude` lane (`.kiro/pipeline/driver.md` → "Automation-started driver"; automation file
Wake-a-driver point 3; collaboration.md §7a). The live queue shows `floor-retry-code` as `state: ready`,
`seat: exafyltd` on branch `origin/pm-agent/sparring-floor-retry` (updated 2026-10-21T14:03Z by `pm-agent`), i.e. the
exceptions seat holds it; PM bookkeeping PR #4249 is open with checks still running (not an automation-driver action).
`CLAUDE_AVAILABLE` unreadable from Kiro Web (HTTP 403 → no override). Front matter unchanged except `updated`
(next_actor stays `claude`). No VTID, no merge, no dispatch, no live-system write. Releasing the `_plan` claim on
stop; the next wake-up resumes from git.

### 2026-10-21T18:03Z · kiro-exafy-202610211801-d857 · approved (automation driver resume, no buildable work)
Automation wake-up (seat exafy, `.kiro/automations/exafy.md`), fallback item W. This plan is `approved`,
`author_seat: exafy`, and its driver was not alive (`plan-driver.mjs heartbeat-age` = `none`). Took it over: wrote
the heartbeat on `refs/heads/collab-driver/sparring-floor-retry` (took over stale driver
`kiro-exafy-202610211701-5a71`) and took the `_plan` claim as `kiro-exafy-202610211801-d857`. Resumed from git:
`plan(` PR merged (spec on `origin/main`), VTID-05240 allocated, no open plan PR, no sparring round awaiting a
response, nothing `in-review`, nothing to land (an automation-started driver never merges). `plan-driver.mjs next`
still returns only `build floor-retry-code`, which is `executor: claude`, `seat: claude`, on governance paths
`scripts/collab/**` and `services/gateway/src/services/plan-sparring/**` (incl. the protected gate file
`scripts/collab/plan-spar.mjs`); an automation-started driver may not build a governance or `executor: claude` lane
(`.kiro/pipeline/driver.md` → "Automation-started driver"; automation file Wake-a-driver point 3; collaboration.md
§7a). The live queue shows `floor-retry-code` as `seat: exafyltd` on branch `origin/pm-agent/sparring-floor-retry`
(updated 2026-10-21T18:02Z by `pm-agent`), i.e. the exceptions seat holds it; PM bookkeeping PR #4249 remains open
(not an automation-driver action). Front matter unchanged except `updated` (next_actor stays `claude`). No VTID, no
merge, no dispatch, no live-system write. Releasing the `_plan` claim on stop; the next wake-up resumes from git.

### 2026-10-22T02:03Z · kiro-exafy-202610220201-bbdd · approved (automation driver resume, no buildable work)
Automation wake-up (seat exafy, `.kiro/automations/exafy.md`), fallback item W. This plan is `approved`,
`author_seat: exafy`, driver not alive (`heartbeat-age` = `none`, prior driver `kiro-exafy-202610220101-348a`
stale). Took it over: heartbeat on `refs/heads/collab-driver/sparring-floor-retry` (sha 5b9f0bfa) and took the
`_plan` claim. Resumed from git: `plan(` PR merged, VTID-05240 allocated, sparring converged + policy-approved
(`verdict.md`), no open sparring round, nothing `in-review`, nothing to land (an automation-started driver never
merges). `plan-driver.mjs next` returns only `build floor-retry-code`, which is `executor: claude`, `seat: claude`
on governance paths (`scripts/collab/**`, `services/gateway/src/services/plan-sparring/**`, incl. protected gate
file `scripts/collab/plan-spar.mjs`); an automation-started driver may not build a governance or `executor: claude`
lane (`.kiro/pipeline/driver.md` "Automation-started driver"; automation file Wake-a-driver point 3; collaboration.md
§7a). Live queue shows `floor-retry-code` carried by the exceptions seat `exafyltd` on `origin/pm-agent/sparring-floor-retry`
(updated 2026-10-22T01:59Z), which is the correct owner while Claude is unavailable (§7). Nothing for this wake-up
to do. Front matter unchanged except `updated` (next_actor stays `claude`). No VTID, no merge, no dispatch, no
live-system write. Releasing the `_plan` claim on stop; the next wake-up resumes from git.

### 2026-10-22T09:03Z · kiro-exafy-202610220901-eaeb · driver woken (automation run, item W) — no action for an automation driver
Kiro Web automation `exafy` (`.kiro/automations/exafy.md`), seat exafy. Item W: this is the one approved plan with
`author_seat: exafy` whose driver was not alive (`heartbeat-age` = `none`). Wrote the first heartbeat on
`refs/heads/collab-driver/sparring-floor-retry` (took over the stale tip of `kiro-exafyltd-202610220801-d3a6`, >45 min
old) and claimed `sparring-floor-retry/_plan`. I am now this plan's driver.

`plan-driver.mjs next` returns exactly one action: `build floor-retry-code`. An **automation-started driver never
builds a governance lane or an `executor: claude` lane** (`driver.md` §"Automation-started driver"), and `floor-retry-code`
is both — `executor: claude`, seat `claude`, `paths` entirely in protected/governance space (`scripts/collab/plan-spar*.mjs`,
`services/gateway/src/services/plan-sparring/**`). There is no other action available: no open sparring round, no
`in-review` lane, no lane PR to fix-forward, nothing an automation driver may merge. The lane stays `ready` with
`next_actor: kiro` (PLAN-SPAR hardcodes `kiro` on allocation though `executor: claude`); it belongs to Claude Code /
the exceptions seat under collaboration §7, not to this automation run.

Per the automation's item W and `driver.md`, I did the one item (establish a live driver), leave the plan state and the
lane untouched, write a last heartbeat, and release the `_plan` claim so the lane is not blocked — the next wake-up (or
an interactive driver / the exceptions seat when it builds the `executor: claude` lane) resumes from git. No VTID, no
code change, no merge, no live-system write.

### 2026-10-22T11:03Z · kiro-exafy-202610221101-cba4 · driver re-woken (automation run, item W) — no action for an automation driver
Hourly exafy wake-up. Same situation as the 09:03Z entry: of this seat's `author_seat: exafy` plans with no live
driver (`sparring-floor-retry` approved, `plan-spar-vitana-v1-ref` in-review, `sparring-model-fallback` drafted), only
`sparring-floor-retry` is `approved|executing`, so W selected it. Its heartbeat had gone stale again; wrote a fresh
heartbeat (took over the stale tip of `kiro-exafy-202610221001-dbf8`) and hold the `_plan` claim — the plan has a live
driver again. The only lane `floor-retry-code` is `executor: claude` on governance paths, which an automation-started
driver never builds, and the exceptions seat `exafyltd` is already carrying it on `pm-agent/sparring-floor-retry` (§7
Claude-unavailable mode). No sparring round, no in-review lane, nothing to merge. One item done (live driver); leaving
plan state and lane untouched; releasing the `_plan` claim on stop. No VTID, no code change, no merge, no live write.
