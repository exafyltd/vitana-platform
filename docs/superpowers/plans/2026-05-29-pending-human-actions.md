# ORB Recovery + Memory Resilience — Pending Human Actions

**One place to look.** This file aggregates every action that requires human/prod hands
(merge, deploy, DB writes, cross-repo edits, real-account smokes) for the autonomous
execution of `2026-05-29-orb-recovery-autonomous-execution.md`.

The autonomous agent runs in a sandbox that **cannot** merge PRs, run EXEC-DEPLOY,
reach prod URLs, write to Supabase, or edit the `vitana-v1` repo / `orb-agent` Python.
Each phase is delivered as a **draft PR that builds + passes jest**; the remaining
steps are listed here.

Legend: each box is a ~30-second click or a copy-paste command, not an engineering task.

---

## Phase Re-Apply

- [ ] Merge PR #2400 — https://github.com/exafyltd/vitana-platform/pull/2400 (VTID-03184 plan_phase branching re-apply)
- [ ] Merge PR #2401 — https://github.com/exafyltd/vitana-platform/pull/2401 (BOOTSTRAP-i18n-llm-locale re-apply)
  - Order independent; disjoint file sets.
- [ ] After each merge, confirm EXEC-DEPLOY SUCCESS, then:
  ```bash
  curl -sS https://gateway-86804897789.us-central1.run.app/alive
  ```
- [ ] Real-account acceptance:
  - dragan3 mobile audio still works after VTID-03184 deploy.
  - dragan3 mobile audio still works after i18n deploy.
  - No regression in characterization snapshots (CI covers).
