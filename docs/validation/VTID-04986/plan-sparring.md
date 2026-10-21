# Plan sparring record — VTID-04986

Gate: Plan Sparring Gate (VTID-04868, CLAUDE.md rules 51–55). Partner: independent read-only plan-sparring-partner agent (Opus 4.6, session tier), saw only the plan file and the code.

Plan hash (sha256 of the text between the plan markers): b76c4464efcb7c6f2d6b294a4e5aeef123be7789b477406e8a8fabaf02cc56c8

- Class: light. Rounds: 2. Round 1 — NOT CONVERGED (F1 major: crash diagnosis pointed at the wrong file; F2–F5 minor). Round 2 — CONVERGED: F1–F5 and Q1–Q3 closed, each verified against the code.
- Verdict: CONVERGED. Owner approval: 2026-10-08 in the Claude Code session ("Yes, both plans approved").

---

# PLAN D — Overview follow-ups: screen-inventory generator fix + retire the unused overview-timeseries route

Change class: **light** (≤3 source files + generated output; no migration, no auth, no workflow, no LLM routing).
Repo: exafyltd/vitana-platform.

<!-- plan:begin -->
## Goal
Two leftovers from Overview Phases 2–4 (VTID-04885/04886/04887, merged in #3917, live in production):
1. `services/gateway/specs/dev-screen-inventory-v1.json` still lists the four retired Overview tabs
   (live-metrics, recent-events, errors-violations, release-feed). Its generator
   `services/gateway/scripts/regen-screens-catalog.mjs` cannot run: it crashes with
   `ReferenceError: Inbox is not defined` (line ~383). Phase 4 therefore did not regenerate the file.
2. `GET /api/v1/ops/overview-timeseries` (`services/gateway/src/routes/ops-overview-timeseries.ts`, mounted
   in `src/index.ts`) lost its only frontend caller in Phase 4.

## Changes
1. Fix the generator's ReferenceError at its root (find which symbol it expects — likely an icon/name
   referenced unquoted in a parsed NAVIGATION_CONFIG snippet — and make the parser handle it), run it, and
   commit the regenerated inventory (the four tabs gone, nothing else changed unexpectedly — the diff is
   reviewed and any other drift is explained in the PR).
2. Before deleting the route: search every caller across both repos (app.js, other frontends, scripts,
   workflows, staging-tests.json, OASIS/Operator tools, vitana-v1). If any caller exists, keep the route and
   only document it. If none: delete the route file, its mount in index.ts, its tests, and any domain-atlas
   claim; regenerate the command-hub symbol index if it references it.
3. Tests: a guard that the inventory lists no retired Overview tab; `test:roles` (atlas drift guard) and the
   command-hub suite stay green; the full gateway suite runs before push.
4. Evidence pack `docs/validation/<VTID>/` with read-only staging-tests.json: the route returns 404 JSON/HTML
   on staging after deploy (or stays 401 if kept), `/alive` 200.

## Not in scope
Any other inventory cleanup the regenerated diff reveals beyond explaining it; frontend changes.

## Risks
- Deleting a route someone still calls → mitigated by the caller search across both repos and logs-free
  evidence (repo search only; no production probing beyond unauthenticated GETs).
- Generator output churn → reviewed in the PR; if large unrelated drift appears, commit only after explaining.
<!-- plan:end -->

---
# Planner responses — round 1 (the plan between the markers is amended by these)

F1 ACCEPTED — diagnosis corrected: the crash is in `loadAdm()` (`regen-screens-catalog.mjs:~233`,
  `vm.runInNewContext`) evaluating vitana-v1 `src/config/admin-navigation.ts`; the `ctx` icon stubs
  (lines ~228-232) lack `Inbox` and `Briefcase`. Fix (Q1): dynamic stubs — before eval, extract every
  identifier used in `icon:` positions (and any other bare identifiers the evaluated source references,
  found by a regex over the source) and stub each as an inert value, so a new icon can never break the
  generator again. A unit test feeds a fixture with an unknown icon and asserts the generator still parses.
F2 ACCEPTED — `services/gateway/src/frontend/command-hub/navigation-config.js` is the second generated
  output of the same run; both are committed, and the PR explains the diff of each (the four retired tabs
  gone; any other drift explained).
F3 ACCEPTED — `services/gateway/.env.example` comment naming `ops-overview-timeseries.ts` is updated in the
  deletion.
F4 ACCEPTED — `scripts/aws-staging-validation/route-manifest.json` is a generated snapshot consumed by
  `capture-snapshot.sh` (manual operator script, not CI; `generate-route-manifest.mjs` writes it). The
  manifest is regenerated with `generate-route-manifest.mjs` in the same PR (never hand-edited), so the
  deleted route disappears from it.
F5 ACCEPTED — class note corrected: still **light** by its rules (no migration, route-add, auth, `.github`,
  deploy, governance or LLM-routing change; a route REMOVAL with no caller), but the file count is ~5 source
  + 3 generated, stated honestly.

Q2 — answered in F4 (manual script input; regenerated, not hand-edited).
Q3 — the guard is the generator's own `--check` mode, which the `REGEN-SCREENS-CATALOG.yml` workflow already
  runs on changes to the generator; additionally one small Jest test asserts the committed inventory and
  navigation-config.js contain none of the four retired Overview tab ids, so a stale regen fails CI even if
  the workflow is skipped.
