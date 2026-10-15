# Tasks — Project Manager Agent

Author: claude. Plan: `plan-sparring.md` (authoritative). One lane = one VTID = one PR. Every lane PR copies
`plan-sparring.md` to `docs/validation/<VTID>/plan-sparring.md` and adds `scope.json` + `acceptance.md` there
(`staging-tests.json` for lanes that deploy). Commits carry `Collab-Session` / `Collab-Lane` trailers. Kiro: never
allocate a VTID, merge, deploy, or write to Supabase/AWS; a database change is a migration file in a Claude lane.

<!-- lane: p0-lane-scope -->
## P0 — lane schema + Lane scope (VTID-05213, claude)  [both repos]
- [x] Lane fields `executor`, `reviewer_seat` (≠ `seat`), `paths` (required once working); handoff `author_seat`.
- [x] Governance paths; a Kiro lane never declares or changes one.
- [x] `queue.mjs scope-check` (+ cross-repo lane fetch for vitana-v1); `SESSION_RE` literals `pm-agent`, `ci-plan-spar`.
- [x] Programme registry reader + validation, `queue --program` and a `program` column (moved here from P2).
- [x] PR-GATE job "Lane scope" in both repos; tests.

<!-- lane: p1-plan-spar -->
## P1 — PLAN-SPAR.yml + policy approval (VTID-05214, claude)  [vitana-platform]
- [ ] `.github/workflows/PLAN-SPAR.yml` (plan §3): `GITHUB_TOKEN` commits, `ci-plan-spar` guard, per-PR concurrency,
      same-repo PRs only, token only in the curl/jq step.
- [ ] Migration: `plan_sparring_sessions.policy_approved_at/policy_approval_rule`; `_plan_sparring_gate_eval` accepts
      either approval; `plan_sparring_append_round` freezes on either; `pm_digests`, `pm_lease` (RLS, service only).
- [ ] Service: `approveSparringSession` treats policy approval as approved; policy approval only on converged + hash
      match + every finding answered; reconciler check `policy_approval_on_non_converged`.
- [ ] CI VTID allocation behind repo variable `PLAN_SPAR_ALLOCATE` (off until the migration is live).
- [ ] Jest tests; `DATABASE_SCHEMA.md`.

<!-- lane: p2-registry -->
## P2 — programme registry content (VTID-05215, kiro · seat exafyltd · review jtadic)  [vitana-platform]
- [ ] `docs/programs/<id>/program.md` for the 8 programmes (multi-tenant, native-app, commerce-portal, calendar,
      proactive-assistant, desktop-redesign, timeline-rebuild, aurora-cutover) + `health-hub` if it has an owner doc.
      Front matter: `id, title, status (active|paused|done), priority (1-5), repos, specs: [<repo>:<slug>], docs,
      exit_criteria, next_review`. Links only — never copy or rewrite plan text.
- [ ] Every current spec (`.kiro/specs/*` in both repos) listed by exactly one programme.
- [ ] `node scripts/collab/queue.mjs validate …` passes; `queue --program <id>` shows its lanes.

<!-- lane: p3-observe-decide -->
## P3 — PM observe + decide, dry_run (VTID-05216, kiro · seat jtadic · review exafyltd)  [vitana-platform]
- [ ] `services/gateway/src/services/project-manager/`: queue reader (port of queue.mjs collect/buildQueue over the
      GitHub API), observe (PRs, checks incl. "Lane scope", Claude Approvals App check, STAGING-VERIFY, ledger).
- [ ] Pure `decide()` (plan §6.2): merge preconditions, reassign after 24 h, park rules, Gate-2 batch timing.
- [ ] 10-min `setInterval` in `index.ts` behind `PM_AGENT_ENABLED` + `PM_MODE` (default dry_run); `pm_lease` per tick;
      OASIS `pm.decision` only. `GET /api/v1/project-manager/status` (exafy_admin).
- [ ] Table tests: each merge precondition false → no merge; reassign; park; batch; lease skip.

<!-- lane: p4-act -->
## P4 — PM act (VTID-05217, kiro · seat jtadic · review exafyltd)  [vitana-platform]
- [ ] Export safe-merge as an in-process function with a typed result (`merged | already_merged | refused`), no
      behaviour change to the route.
- [ ] `live` mode: merge, lane-file commits as `pm-agent`, reassign, park, Gate-2 batch to the Operator Chat (existing
      run-view question, every commit between production and the verified commit).
- [ ] Integration tests (fake GitHub + in-memory DB): never deploys, dispatches, allocates; never merges a
      governance-path PR without a `claude` review; already-merged is a no-op.

<!-- lane: p5-rules -->
## P5 — rules and automations for the new roles (VTID-05218, claude)  [both repos]
- [ ] `.claude/rules/collaboration.md` + Kiro twin (§7 roles, §7a, §8), CLAUDE.md (Autonomy Contract, rules 51–55),
      plan-sparring skill, `.kiro/automations/*.md` order of work, `scripts/collab/routine-prompt.md`.

<!-- lane: p6-board -->
## P6 — Command Hub programmes board (VTID-05219, kiro · seat exafyltd · review jtadic)  [vitana-platform]
- [ ] Read-only board: programmes → specs → lanes (seat, reviewer seat, state, PR, CI, age, park reason), PM mode +
      switch (exafy_admin), digests, Gate-2 batches waiting. Bump `?v=` in Command Hub `index.html`.
- [ ] `staging-tests.json`: read-only render of the board + status GET.

<!-- lane: p7-switch-on -->
## P7 — staging switch-on (VTID-05220, claude)  [vitana-platform]
- [ ] Staging gateway env: `PM_AGENT_ENABLED=true`, `PM_MODE=dry_run` for 3 days, then `live`; production stays off.
- [ ] One docs-only test lane end to end (Kiro builds → other seat reviews → PM merges).
