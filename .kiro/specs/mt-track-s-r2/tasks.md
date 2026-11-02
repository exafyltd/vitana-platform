# Tasks — mt-track-s-r2
Authoritative plan: `plan.md`. VTIDs from CI PLAN-SPAR. Both lanes in `exafyltd/vitana-v1`. Branch
`kiro/mt-track-s-r2/<lane>`; PR title `VTID-xxxxx (mt-track-s-r2/<lane>): …`; trailers `Collab-Session` +
`Collab-Lane: mt-track-s-r2/<lane>`; identity `kiro-agent[bot]`; evidence in `docs/validation/<VTID>/`.

<!-- lane: s-j-route-inventory -->
## Lane `s-j-route-inventory`
- [ ] T1 Re-check plan §2 at the lane base: `git grep linkedin-import -- src supabase/functions
      ':!supabase/functions/linkedin-import'` hits only the s4 test; no `invoke('linkedin-import'` in either repo.
      A real caller → stop, log it, do not delete.
- [ ] T2 Delete `supabase/functions/linkedin-import/**` and its `[functions.linkedin-import]` block in
      `supabase/config.toml`.
- [ ] T3 Update `src/lib/edge-functions-caller-identity.s4.test.ts` per plan §4 step 3 (drop only the
      `linkedin-import` references; keep every other function's assertions as they are).
- [ ] T4 Add `scripts/check-edge-function-auth.mjs` per plan §4 step 4 with the generated, tagged `LEGACY` map; wire it
      into `package.json` `"test"` before `vitest run`.
- [ ] T5 Evidence: red on base (script missing), green after; planted-folder and missing-`LEGACY`-key failures shown;
      full `npm test` output; `staging-tests.json` with a read-only `existing` ref to the gate.

**Acceptance**
- Change types: Backend (edge functions), Tooling/docs.
- Outcome: the unused `linkedin-import` edge function is gone from the repo, and CI fails any new edge function that
  does not import and call the shared caller-auth gate.
- States: n/a: no runtime UI or route change.
- Surfaces: callers — none (T1 proves no caller); CI `npm test`.
- Locales: n/a: no user-visible text.
- Accessibility: n/a: no UI.
- Contract: the gate's exit code (0 green, non-zero with the offending function names); `package.json` `"test"` runs it.
- Staging proof: not verified on staging: an edge-function folder removal deploys nothing to staging; the CI gate and
  the s4 suite prove it, referenced from `staging-tests.json` as `existing`.
- Only the lane `paths` change; the s4 test loses only `linkedin-import` references; no legacy function is edited.

<!-- lane: s-j-retire-allowlist -->
## Lane `s-j-retire-allowlist`
- [ ] R1 Add `linkedin-import` to `ALLOWLIST` in `.github/workflows/SUPABASE-FUNCTIONS-RETIRE.yml` (`:42-45`). Nothing
      else in the workflow changes.
- [ ] R2 Evidence: red on base (name absent), YAML parses after; `staging-tests.json` with a read-only `existing` ref.
- [ ] R3 The lane never dispatches the workflow. The dispatch is the owner-approved plan-driver step of plan §3.

**Acceptance**
- Change types: Infrastructure/CI.
- Outcome: the retire workflow accepts `linkedin-import` once its folder is gone; nothing is deleted by this lane.
- States: n/a.
- Surfaces: `SUPABASE-FUNCTIONS-RETIRE.yml` (dispatch-only).
- Locales: n/a. Accessibility: n/a.
- Contract: `ALLOWLIST` is a space-separated list; the workflow's existing guards (main-only, folder absent, no caller)
  are untouched.
- Staging proof: not verified on staging: a workflow edit deploys nothing; CI YAML check referenced as `existing`.
- The diff is one line in `ALLOWLIST` plus `docs/validation/**`; no workflow run is dispatched by the lane.

## Escalation carry-over (from `mt-track-s`, session `d0c274cd`, round 3)
- R3-F1 [blocker], verbatim: "The s-j-retire-function lane plan assigns the SUPABASE-FUNCTIONS-RETIRE.yml workflow
  dispatch to Claude Code during lane execution."
  Answered in plan §3: no lane executes the dispatch; the plan driver dispatches only on the owner's explicit approval
  asked with Gate 2. Acceptance: no lane PR contains or triggers a dispatch; `handoff.md` records the run with
  `authority: owner instruction <ISO time>`, or records S-J as open at "source removed, deployed copy auth-gated".
