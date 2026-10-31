---
slug: i18n-propagate-stale-write
author: kiro
author_seat: exafyltd
executor: claude
next_actor: claude
state: drafted
updated: 2026-10-21T08:56Z
---
# Handoff — I18N-PROPAGATE stale-write fix

Plan authored by Kiro (session `kiro-202610152203-0347`) while finishing the desktop Spotlight fix-forward
(exafyltd/vitana-v1#1399), where the `I18N-PROPAGATE` bot reverted human translations (`6b698ac98` over `2f5c0cbf4`,
re-applied in `ab05df942`). Code repo: exafyltd/vitana-v1. Spec in vitana-platform because PLAN-SPAR runs only here.

One lane, `fix-workflow` (`executor: claude`, it changes `.github/**`). Root cause, fix and test plan: `plan.md`.

## Log
### 2026-10-16T10:25Z · kiro-202610152203-0347 · created → drafted
Investigated read-only: the workflow YAML, `scripts/translate-keys.mjs`, `scripts/i18n-stamp-source.mjs`, run
38443615525's job timings and `collect` log, and the three commits on #1399. Drafted requirements, design, tasks, plan,
this handoff and `lanes/fix-workflow.md`. No VTID, no claim on the lane, no live writes, no workflow dispatched.
next_actor: claude — PLAN-SPAR spars the plan; then allocate the VTID and execute the lane (governance path).

### 2026-10-18T22:45Z · kiro-202610182052-5ce2 · sparring round 1 answered
Claimed `_plan`. Answered R1-F1, R1-F2, R1-F3 (all accepted) in `sparring/responses-1.md` after re-reading the
vitana-v1 premises at `5c4632ea9` and `origin/main` `704b5def4` (unchanged). Plan block now carries verbatim premise
excerpts, the explicit collect/pivot retry shape, file-scope rules and test scenarios h–k. No VTID, no live writes,
no workflow dispatched. next_actor: claude — the push starts PLAN-SPAR round 2.

### 2026-10-18T22:48Z · ci-plan-spar · escalated (partner unavailable)
The sparring partner could not review (model_unavailable). Not a plan problem: Claude Code looks at the partner, then re-runs.

### 2026-10-21T08:56Z · kiro-202610182052-5ce2 · re-trigger sparring after infra escalation
Session 53dfe2bf escalated at round 2 on `model_unavailable` (Bedrock daily token quota; `state.json` infra+retryable), not on a finding. Re-verified every vitana-v1 premise at origin/main 1a553367f (I18N-PROPAGATE.yml, i18n-check.yml and the pr-gate tests unchanged since 5c4632ea9; `scripts/i18n-propagate-apply.mjs` still absent) and updated the pin in the plan block, noting the new session can read vitana-v1 (#4201); corrected the PLAN-SPAR.yml trigger cite to :23-28. Appended a re-trigger note to `sparring/responses-1.md` so PLAN-SPAR retries with a new session. No VTID, no live writes, no workflow dispatched.
