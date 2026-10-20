# Tasks — mt-track-s (Track S security hotfixes + Health Phase 0 live defects)

Authoritative plan: `plan.md` (between the `plan:begin`/`plan:end` markers). Lane files: `lanes/`.
Almost all of Track S / WS10 is already closed (see `plan.md` ## Problem and `requirements.md`); this spec plans only
the S-J residual.

<!-- lane: s-j-route-inventory -->
## s-j-route-inventory — remove dead `linkedin-import`, add edge-function auth inventory test (VTID: allocated by PLAN-SPAR after approval, Kiro, repo vitana-v1)

Allowed paths:
- `supabase/functions/linkedin-import/**`
- `supabase/config.toml`
- `src/lib/edge-functions-caller-identity.s4.test.ts`
- `scripts/check-edge-function-auth.mjs`
- `package.json`
- `docs/validation/**`

(Allowed paths are vitana-v1 paths and are identical to `lanes/s-j-route-inventory.md` `paths:`. The gate is a node
`scripts/check-edge-function-auth.mjs` wired into `package.json` `"test"`, matching the repo's existing
`scripts/check-edge-data-client.mjs` / `scripts/check-realtime-helper.mjs` convention — a vitest `.test.ts` under
`supabase/functions/**` would never be collected because `vitest.config.ts` `include` is `src/**/*.test.{ts,tsx}`
(verified `vitana-v1/vitest.config.ts:22`, `vitana-v1/package.json` `"test"`). `supabase/config.toml` and the
collected vitest suite `src/lib/edge-functions-caller-identity.s4.test.ts` are in scope because deleting
`linkedin-import` orphans its `config.toml` registration and breaks that suite — see T2 / T2a.)

- [ ] T1 Confirm `linkedin-import` is unused: grep both repos for `linkedin-import` and `functions.invoke('linkedin-import'`.
      IF a live consumer exists, STOP, record it in the lane log, set `next_actor: claude` — do not delete.
- [ ] T2 Delete `vitana-v1/supabase/functions/linkedin-import/**` (VTID-05049 flagged it for removal; `social-media-import`
      replaced it) AND remove the orphaned `[functions.linkedin-import]` block from `vitana-v1/supabase/config.toml`
      (`:72-74`, `verify_jwt = true`) so no registration of a deleted function is left behind.
- [ ] T2a Update the collected vitest suite `vitana-v1/src/lib/edge-functions-caller-identity.s4.test.ts`: drop
      `'linkedin-import'` from the four places that read the now-deleted file — the `the five functions use caller-auth`
      loop (`:77-88`), the profile-import loop `['linkedin-import','social-media-import']` (`:90-92`), the
      `linkedin-import is flagged for removal` case (`:107-110`), and the `arrayContaining([...])` scan assertion
      (`:272`). Keep `social-media-import` / `fetch-user-context` coverage unchanged. This file is under `src/**`, so
      vitest collects it; without this edit `npm test` fails on the missing file.
- [ ] T3 Add `vitana-v1/scripts/check-edge-function-auth.mjs` (follow the shape of `scripts/check-edge-data-client.mjs`:
      walk `supabase/functions/**`): enumerate every `supabase/functions/*/index.ts`; each function NOT in a frozen
      in-script `LEGACY` map must import `_shared/caller-auth.ts` AND call `requireUser`/`isServiceRoleCaller`/
      `isTriggerSecretCaller`; a `LEGACY` key with no folder also fails (the map only shrinks). `LEGACY` = the 59
      pre-caller-auth functions enumerated in `plan.md` ## Fix, each tagged B-user / B-sig / B-secret / C-unreviewed.
      Do not edit any legacy function. Add it to `package.json`
      `"test"` next to the two existing `check-*.mjs` scripts (…`&& node scripts/check-edge-function-auth.mjs && vitest run`).
      The gate must fail if `linkedin-import` reappears ungated.
- [ ] T4 `docs/validation/<vtid>/`: copy of `plan-sparring.md`, `scope.json` (kind chore, the allowed paths),
      `staging-tests.json` (the read-only staging spec if added, plus the inventory gate).

Acceptance: `linkedin-import` is gone, including its `supabase/config.toml` registration; the collected suite
`src/lib/edge-functions-caller-identity.s4.test.ts` no longer references `linkedin-import` and still covers
`social-media-import`/`fetch-user-context`; `node scripts/check-edge-function-auth.mjs` exits 0 on the current function
set and non-zero on a planted ungated function; full `npm test` green (the new check runs inside the `"test"` chain;
nav registry, design manifest, i18n lint unaffected — no App.tsx route added); no migration; PR title
`VTID-xxxxx (mt-track-s/s-j-route-inventory): …`; commits carry `Collab-Session: <kiro id>` and
`Collab-Lane: mt-track-s/s-j-route-inventory`. Kiro never calls a write endpoint against any live system; staging
verification is read-only.

<!-- lane: s-j-retire-function -->
## s-j-retire-function — undeploy `linkedin-import` via the RETIRE workflow (VTID: allocated by PLAN-SPAR after approval, Claude Code, repo vitana-v1)
Allowed paths:
- `.github/workflows/SUPABASE-FUNCTIONS-RETIRE.yml`
- `docs/validation/**`
(Identical to `lanes/s-j-retire-function.md` `paths:`. `.github/**` is a governance path, so `executor: claude`.
Depends on `s-j-route-inventory`: the RETIRE workflow refuses any name still under `supabase/functions/`.)
- [ ] R1 Add `linkedin-import` to the `ALLOWLIST` in `vitana-v1/.github/workflows/SUPABASE-FUNCTIONS-RETIRE.yml`
      (`:42-45`); one commit, PR under this lane's VTID.
- [ ] R2 After merge, dispatch the RETIRE workflow for `linkedin-import` under this lane's VTID; record the run link and
      its `Confirm` step output (a read of the project function list showing it absent) in `docs/validation/<vtid>/`.
Acceptance: `linkedin-import` absent from the deployed function list per the retire run's `Confirm` step; S-J closed.

## Escalation carry-over (owner approved escalated, 2026-10-20)

The plan was round-capped and escalated (session `d0c274cd`, s2 round 3); the owner approved it as escalated on
2026-10-20 ("yes, A all 4 approved"). The open last-round finding is folded into the lane tasks here; `plan.md` is
unchanged. Where R2 above conflicts with this section, this section wins.

- R3-F1 [blocker] — "The s-j-retire-function lane plan assigns the SUPABASE-FUNCTIONS-RETIRE.yml workflow dispatch
  to Claude Code during lane execution."
  Lane `s-j-retire-function`, R2 is replaced by:
  - [ ] R2' The lane's executor (Claude Code) does R1 only and never dispatches the workflow (collaboration §7a
        applies to Claude Code whenever it executes a lane). After the R1 PR merges, the Project Manager (or the
        owner) dispatches `SUPABASE-FUNCTIONS-RETIRE.yml` for `linkedin-import` under this lane's VTID. The run
        link and its `Confirm` step output (a read of the project function list showing it absent) are recorded
        in `docs/validation/<vtid>/` by the Project Manager, or by Claude Code afterwards as a coordinator
        follow-up outside lane execution — not as a lane-execution step.
        Acceptance (carry-over R3-F1): the lane's PR contains no workflow dispatch by the executor; the dispatch
        actor named in `docs/validation/<vtid>/` is the Project Manager or the owner; S-J closes when the
        recorded `Confirm` output shows `linkedin-import` absent.