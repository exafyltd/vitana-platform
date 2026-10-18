# Sparring round 1 — in_progress

Session: `2d48c240-26ae-4ed6-99da-f843e1ec59c9` · plan hash `28ed4bfb2f6669fe156b759f84d73bda99a5485f6359698b886714d2592d8cba`

## Summary

The plan is structurally sound at a high level (env profiles, fixture-only smoke, gated owner switch) but has two blockers and three major findings that must be resolved before implementation. The central problem is that the sparring session is pinned exclusively to `vitana-platform` while every line of implementation code lives in `vitana-v1` — making all code-level premises unverifiable. Two additional findings (a fabricated CLAUDE.md section citation and a cross-repo lane that will break Lane scope enforcement) are independent of that root issue and must also be fixed.

## Findings

### R1-F1 [blocker]

The sparring session is pinned only to vitana-platform, but every piece of implementation code the plan premises are drawn from lives in vitana-v1. This means the partner cannot read — and therefore cannot verify — any of the cited file:line claims: `apps/mobile/src/config/env.ts:82/105/189`, `apps/mobile/app.config.ts:36`, `tools/orb-fake-gateway/server.js:1`, `src/push/provider.ts:52`, the parity ledger, the shell, the push/linking scaffolding. PLAN-SPAR.yml checks out only `vitana-platform` (line 50: `ref: ${{ github.event.pull_request.base.sha }}`). There is no pinned ref for vitana-v1 in this session. The `program.md` confirms the mobile app lives in vitana-v1 ('Expo / React Native, `apps/mobile/` in vitana-v1') and `handoff.md` repeats it. CLAUDE.md rule 52 requires the partner to 'verify the plan's premises against the code (`file:line`)'. A sparring session that cannot read any of the cited code cannot perform that function — the governance gate has no evidence to stand on.

- `exafyltd/vitana-platform:.github/workflows/PLAN-SPAR.yml:47` — - name: Base checkout (trusted code)
          uses: actions/checkout@v4
          with:
            ref: ${{ github.event.pull_request.base.sha }}
            path: base
            persist-credentials: false
- `exafyltd/vitana-platform:docs/programs/native-app/program.md:9` — - vitana-v1:docs/programs/native-app/NATIVE-APP-PLAN.md
...exit_criteria:
    - The exit criteria of vitana-v1 docs/programs/native-app/NATIVE-APP-PLAN.md are met
- `exafyltd/vitana-platform:.kiro/specs/health-native/handoff.md:22` — | Native Maxina app (Expo / React Native, `apps/mobile/` in vitana-v1, replaces the Appilix wrapper) | VTID-05021 | vitana-v1 `docs/programs/native-app/NATIVE-APP-PLAN.md`
- `exafyltd/vitana-platform:CLAUDE.md:486` — 52. **The partner is independent and adversarial.** It sees the plan and the
      code, never the planner's reasoning; it verifies the plan's premises
      against the code (`file:line`) and its findings are kept verbatim.

Suggestion: Either (a) add `vitana-v1` as a second checkout in `PLAN-SPAR.yml` so the partner has a pinned ref for it, or (b) move the spec to `vitana-v1` per the collaboration rule §2 ('`.kiro/specs/<slug>/` in the repo where most code changes'). The collaboration.md explicitly states 'plans that span both repos: `vitana-platform`' — but this plan's code changes are entirely in vitana-v1, so the spec belongs there. Whichever fix is chosen, the sparring must be re-run with the partner able to read the actual code files.

### R1-F2 [blocker]

The plan cites `docs/programs/native-app/NATIVE-APP-PLAN.md:95` as the source of the §2a G1 gate claim, but this file does not exist in vitana-platform at the pinned commit. The `docs/programs/native-app/` directory contains only `program.md`, which itself confirms the plan lives in `vitana-v1:docs/programs/native-app/NATIVE-APP-PLAN.md`. An unqualified path citation that resolves to a 404 in the pinned repo provides no verifiable governance basis for the G1-gated exit criterion.

- `exafyltd/vitana-platform:docs/programs/native-app/program.md:1` — docs:
    - vitana-v1:docs/programs/native-app/NATIVE-APP-PLAN.md
...
- `exafyltd/vitana-platform:.kiro/specs/health-native/handoff.md:19` — | Program | Umbrella VTID | Plan | ...
| Native Maxina app ... | VTID-05021 | vitana-v1 `docs/programs/native-app/NATIVE-APP-PLAN.md`

Suggestion: All citations to plan governance documents must be repo-qualified: `vitana-v1:docs/programs/native-app/NATIVE-APP-PLAN.md:95`. Additionally, since that file is in vitana-v1 and this sparring session cannot pin vitana-v1, the plan cannot substantiate its governance premise — this feeds directly into R1-F1.

### R1-F3 [major]

The plan states 'All `paths` are under `apps/mobile/**` except `build-profiles` (`.github/**`) and `real-g1-switch` (`docs/validation/g1/**`)' and claims a self-check confirms no in-scope file is orphaned. This is false. The `fixture-gateway` lane scope is declared as `tools/fixture-gateway/**` and `tests/fixture-gateway/**`. The plan itself compares this new tool to the ORB fake at `tools/orb-fake-gateway/server.js` (unqualified path, not `apps/mobile/tools/`), making clear `tools/` is at the vitana-v1 repo root, not inside `apps/mobile/`. Neither `tools/fixture-gateway/**` nor `tests/fixture-gateway/**` is under `apps/mobile/**`. The self-check claim is false and the Lane scope enforcement (`PR-GATE` step) will either reject the PR or silently ignore those paths, leaving the fixture gateway ungoverned.

- `exafyltd/vitana-platform:.claude/rules/collaboration.md:99` — paths:                       # the only files the lane may change (Lane scope); required from executing on
...
The PR-GATE check **Lane scope** fails a lane PR that changes anything else
- `exafyltd/vitana-platform:.kiro/specs/health-native/handoff.md:33` — Native Wave 1 + 1b — the whole stack is on vitana-v1 main:
  N1 `@vitana/core` + `@vitana/tokens` (05183, #1396), N2 UI kit (05176, #1395), N3 shell + i18n keys
  (05186, #1397 + #1400), N4-APP push/links/remote config (05178, #1390)

Suggestion: Add `tools/fixture-gateway/**` and `tests/fixture-gateway/**` (and any other root-level vitana-v1 paths) to the explicit exceptions list in the path ownership summary. Also verify that `tests/g1-smoke/**` in `deep-link-push-smoke` is similarly under `apps/mobile/` or needs the same exception treatment.

### R1-F4 [major]

The `build-profiles` lane declares scope `eas.json, .github/workflows/NATIVE-CI.yml` and the plan maps its paths to `.github/**`. But `eas.json` is an Expo build-profile file that must live at `apps/mobile/eas.json` in vitana-v1, while `NATIVE-CI.yml` lives in vitana-platform's `.github/workflows/`. A single lane cannot span two repos under the collaboration protocol — lane files carry one `branch:` and one `pr:`. If `eas.json`'s path is declared as `apps/mobile/eas.json`, the Lane scope check will reject the `.github/**` PR for touching a path not in its declared scope, and vice-versa. The plan gives no account of how a cross-repo lane is executed or reviewed.

- `exafyltd/vitana-platform:.claude/rules/collaboration.md:50` — lane: <lane-id>              # = file name, lowercase-dashes
state: ready | executing | in-review | verified | done | parked
...
branch: <branch>
pr: <url>
- `exafyltd/vitana-platform:.claude/rules/collaboration.md:98` — paths:                       # the only files the lane may change (Lane scope); required from executing on
    - src/pages/messages/**
...
The PR-GATE check **Lane scope** fails a lane PR that changes anything else

Suggestion: Split `build-profiles` into two lanes: one `executor: claude` lane in vitana-platform covering `.github/workflows/NATIVE-CI.yml` only, and a second `executor: kiro` lane in vitana-v1 covering `apps/mobile/eas.json`. Each gets its own branch, PR, and VTID. The dependency order is preserved (eas.json lane depends on env-profiles; NATIVE-CI lane depends on eas.json lane).

### R1-F5 [major]

The plan cites `root CLAUDE.md "Why no host is exempt"` as the source for the production/staging safety justification. Reading all 1016 lines of CLAUDE.md at the pinned commit, no section, heading, or quoted phrase matching 'Why no host is exempt' exists. Rule 31 covers the same concept ('NEVER write as this account — on ANY host. Reading is fine everywhere. There is exactly one Supabase project and every frontend (incl. preview/staging) writes to it — the host selects which code runs, not which database gets written') but is not titled or indexed with that phrase. Citing a non-existent heading as governance evidence is a fabricated citation.

- `exafyltd/vitana-platform:CLAUDE.md:599` — 31. **NEVER write as this account — on ANY host. Reading is fine everywhere.**
      Not a post, comment, like, profile edit, onboarding step, or wallet call.
      **There is exactly one Supabase project and every frontend (incl. preview/
      staging) writes to it** — the host selects which code runs, not which
      database gets written, so "do it on the preview instead" mitigates
      nothing.

Suggestion: Replace the fabricated heading citation with the actual rule reference: `CLAUDE.md rule 31 (VTID-03506): "There is exactly one Supabase project and every frontend (incl. preview/staging) writes to it."` The underlying safety reasoning is valid; only the citation is wrong.

### R1-F6 [minor]

The plan creates `.github/workflows/NATIVE-CI.yml` without acknowledging `MOBILE-DEVICE-E2E.yml`, which already exists in the same directory and covers iOS simulator testing of the Vitana app. No rationale is given for creating a new workflow rather than extending the existing one, and there is no analysis of whether both workflows would trigger on the same paths or events, creating duplicate CI cost.

- `exafyltd/vitana-platform:.github/workflows/MOBILE-DEVICE-E2E.yml:1` — # MOBILE-DEVICE-E2E — real-device-layer frontend testing via sim-use
...
# Runs the Vitana web frontend on a REAL iOS Simulator (macOS runner) and
# drives it through the platform accessibility tree

Suggestion: The plan should explicitly state that `MOBILE-DEVICE-E2E.yml` runs the web frontend in Safari (not the native Expo bundle) and is therefore a different concern. A one-line note to that effect, plus confirmation that the new NATIVE-CI.yml uses `workflow_dispatch` only (to avoid macOS runner cost), would close this gap.

## Next

Planner: answer every finding above in `sparring/responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
