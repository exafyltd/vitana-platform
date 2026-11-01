---
change_class: standard
---
# plan(mt-track-s-r2): close the S-H residual — remove dead `linkedin-import`, add an edge-function auth gate, retire the deployed copy

Author: Kiro, seat `hotmail`, session `kiro-hotmail-202611011402-f523` (Kiro Web). Re-plan of `mt-track-s`
(PR #4165, closed 2026-10-28 after session `d0c274cd` escalated at the round cap). vitana-platform premises pinned to
`origin/main` `62990ce285`; vitana-v1 premises pinned to `exafyltd/vitana-v1@58c76c956` (re-verified 2026-11-01).

<!-- plan:begin -->
## 1. Goal
`docs/MULTI-TENANT-PLAN.md` §3: Track S (live security exposures) is "independent of multi-tenancy, fix first". The
owner instructed the multi-tenant program to run end to end (2026-11-01: "you make the decisions for me"). The prior
spec `mt-track-s` verified that 16 of the 17 Track S / WS10 items are CLOSED (its `plan.md` ## Problem, branch
`kiro/mt-track-s/plan`, lists each with `file:line` and VTID: S-A VTID-05040, S-B/S-D VTID-05041, S-C VTID-04981,
S-E VTID-05043, S-F/S-L VTID-05042, S-G/S-K VTID-05044, S-H VTID-05049/05120, S-I VTID-05048, S-M VTID-05147,
WS10 VTID-05030/05031/05055). This plan closes the **S-H residual**: the dead `linkedin-import` (one of the four S-H functions,
`docs/MULTI-TENANT-PLAN.md:44`) that VTID-05049 auth-gated and flagged for removal, plus a gate that holds every new
edge function to the S-H rule. It changes nothing that shipped. **S-J stays OPEN** and is not closed by this plan: its
canonical scope (`docs/MULTI-TENANT-PLAN.md:46`: every `/debug/*` route and the non-private realtime broadcast
channels) is tracked by `mt-guardrails-r2` (the WS0 route inventory and the unauthenticated-route check, its `plan.md`
§1 item for S-J). The lane ids keep their historical `s-j-` prefix (lane ids are frozen once created); the work is
S-H residual cleanup (sparring R1-F1).

## 2. Today (evidence, vitana-v1@58c76c956 unless stated; the companion pin is declared as `spar_refs` in `handoff.md`, R1-F2)
Every premise below can be read at that pin: vitana-v1 `supabase/functions/linkedin-import/index.ts`,
`supabase/config.toml`, `src/lib/edge-functions-caller-identity.s4.test.ts`, `package.json`, `vitest.config.ts`,
`scripts/check-edge-data-client.mjs` and `.github/workflows/SUPABASE-FUNCTIONS-RETIRE.yml`; vitana-platform
`docs/MULTI-TENANT-PLAN.md:44,46` (S-H, S-J).
- `supabase/functions/linkedin-import/index.ts` still exists; VTID-05049 auth-gated it and flagged it for removal
  (`:4` imports `requireUser`, `:6-8` the removal comment). `social-media-import` replaced it.
- No caller: `git grep linkedin-import -- src supabase/functions ':!supabase/functions/linkedin-import'` hits only the
  test `src/lib/edge-functions-caller-identity.s4.test.ts` (`:6`, `:77`, `:90`, `:107-108`, `:272`); no
  `functions.invoke('linkedin-import'` in vitana-v1 or in vitana-platform `services/`.
- `supabase/config.toml:72-73` registers `[functions.linkedin-import]` with `verify_jwt = true`.
- `package.json:29` `"test"` = `node scripts/check-edge-data-client.mjs && node scripts/check-realtime-helper.mjs &&
  vitest run`; `vitest.config.ts` collects only `src/**/*.test.{ts,tsx}`, so a gate over `supabase/functions/**` is a
  node script, as the two existing `check-*.mjs` are. `scripts/check-edge-function-auth.mjs` does not exist.
- 65 function folders under `supabase/functions/` (excluding `_shared`); 6 `index.ts` import `_shared/caller-auth`.
- Deleting source does not undeploy: `supabase-functions-deploy.yml` never removes deleted folders. The only undeploy
  is `.github/workflows/SUPABASE-FUNCTIONS-RETIRE.yml` (dispatch-only, from `main` only, `ALLOWLIST` at `:42-45`
  currently the 8 memory functions; it refuses a name still under `supabase/functions/` and a name with a caller, then
  deletes via the Supabase management API on project `inmkhvwdcuyhnxkgfvsb`, i.e. production).

## 3. What changed since the escalated session (answers R3-F1 of session `d0c274cd`)
R3-F1 said the retire dispatch had no authorized actor: the old plan gave it to the lane executor, which §7a then
forbade. The rules on `main` now differ:
- `.claude/rules/collaboration.md` §7d lets Kiro dispatch staging, verification and CI workflows itself, and names
  production deploy workflows and live writes as never-without-the-owner.
- `SUPABASE-FUNCTIONS-RETIRE.yml` deletes a function from the production Supabase project, so it is a live production
  write (`.kiro/steering/vitana-owner-autonomy.md` stops 2 and 7). It is therefore **not** a lane-execution step and
  **not** a §7d routine dispatch.
- Decision in this plan: the dispatch has exactly one authorized trigger — the owner's explicit approval in the
  conversation, asked once together with Gate 2 (five-part stop message). On that approval the plan driver (Kiro, `_plan`
  claim holder) dispatches the workflow from `main` with `functions=linkedin-import` and a `reason` naming the VTID,
  watches the run, and records the run link plus the workflow's own result in `handoff.md` with `authority: owner
  instruction <ISO time>`. No lane executor ever dispatches it. Without that approval the S-H residual stays open at "source removed,
  deployed copy auth-gated" (already the VTID-05049 defence in depth), reported in Gate 2.
- `.github/**` is a governance path. §3a on `main` allows an `executor: kiro` lane with `reviewer_seat:
  agent:vitana-lane-reviewer` to change it on a reviewer-agent accept; `SUPABASE-FUNCTIONS-RETIRE.yml` is not a
  protected gate file (`scripts/collab/protected-gate-files.json`). So both lanes are `executor: kiro`; no Claude lane.

## 4. Lanes (both vitana-v1)
### Lane `s-j-route-inventory` (executor kiro, seat hotmail)
`paths`: `supabase/functions/linkedin-import/**`, `supabase/config.toml`,
`src/lib/edge-functions-caller-identity.s4.test.ts`, `scripts/check-edge-function-auth.mjs`, `package.json`,
`docs/validation/**`.
1. Re-check §2 at the lane's base commit; any mismatch (a caller appears) stops the lane and is logged.
2. Delete `supabase/functions/linkedin-import/**` and the `[functions.linkedin-import]` block in `supabase/config.toml`.
3. Edit the collected suite `src/lib/edge-functions-caller-identity.s4.test.ts`: drop `linkedin-import` from the
   "five functions" list (`:77`, the describe becomes four functions), from the profile-import loop (`:90`), remove the
   "flagged for removal" case (`:107-109`) and drop it from the `arrayContaining` scan (`:272`) and the header (`:6`).
   `social-media-import`, `fetch-user-context`, `queue-campaign-recipients` and `send-welcome-discount` coverage stays.
   This is the only test change, and it follows from deleting the file it reads; no assertion about a remaining
   function is removed or loosened.
4. Add `scripts/check-edge-function-auth.mjs` (shape of `scripts/check-edge-data-client.mjs`): every
   `supabase/functions/<name>/index.ts` whose name is NOT a key of a frozen in-script `LEGACY` map must import
   `_shared/caller-auth` AND call one of `requireUser` / `isServiceRoleCaller` / `isTriggerSecretCaller`; a `LEGACY`
   key with no folder also fails (the map only shrinks). `LEGACY` is generated once at the lane's base from the
   functions that do not import caller-auth (59 at `58c76c956`), each tagged with its observed pattern (`B-user` own
   `auth.getUser`/`getClaims`, `B-sig` signature check, `B-secret` shared secret, `C-unreviewed` none recognised). No
   legacy function file is edited. `LEGACY` only shrinks, and the gate keeps it exact (R1-F3): a `LEGACY` key whose
   function now imports `_shared/caller-auth` and calls a recognised check also FAILS, with the message "migrated —
   remove <name> from LEGACY", so the PR that migrates or deletes a legacy function must also drop its key. The
   script's header comment states this rule and how to regenerate the tags. Wire it into `package.json` `"test"`
   before `vitest run`.
### Lane `s-j-retire-allowlist` (executor kiro, seat hotmail, reviewer_seat agent:vitana-lane-reviewer, depends_on s-j-route-inventory)
`paths`: `.github/workflows/SUPABASE-FUNCTIONS-RETIRE.yml`, `docs/validation/**`. One change: add `linkedin-import` to
`ALLOWLIST`. It depends on the first lane because the workflow's own guard refuses a name whose folder still exists.
The lane ends at merge. The dispatch is the owner-approved plan-driver step of §3, not part of this lane.

## 5. Interfaces and shared files
No file is shared between the lanes. No hot file (no migration, no `App.tsx`, no registry, no i18n).

## 6. Tests
- `s-j-route-inventory`, red on base: `node scripts/check-edge-function-auth.mjs` does not exist (exit non-zero);
  after: exits 0 on the remaining 64 functions; exits non-zero on a planted folder `supabase/functions/zz-probe/index.ts`
  with no caller-auth import (temporary, not committed), on a `LEGACY` key whose folder is missing, and on a `LEGACY`
  key whose function already satisfies the rule (planted the same way, R1-F3). Full `npm test`
  green (the gate runs inside `"test"`). Commands and outputs in `docs/validation/<VTID>/`.
- `s-j-retire-allowlist`: the workflow file still parses (`python3 -c 'import yaml…'` or `actionlint` if present) and
  `ALLOWLIST` contains `linkedin-import`; red on base = absent.
- No pgTAP, contract or golden suite: no DB change, no shared instruction surface.

## 7. Staging verification
Both lanes deploy nothing to the gateway or community-app (an edge-function folder removal is not deployed by any
staging workflow; `.github/**` deploys nothing). Each lane's `docs/validation/<VTID>/staging-tests.json` holds a
read-only `existing` ref (the node gate / the YAML check, run in CI) so STAGING-VERIFY never reports the commits as
missing a suite (rule 47). No staging invoke of an edge function (a POST), no production probe (rules 31/31b/48).

## 8. Rollout
Lane PRs → reviewer agent → merge under §7b → STAGING-VERIFY on the next deploy → Gate 2. With Gate 2 the owner is asked
the one extra question of §3 (retire the deployed `linkedin-import` on production: yes/no). Reversible: revert either
PR; a retired function can be redeployed from git history.

## 9. Risks
- A hidden consumer of `linkedin-import`: step 1 of lane 1 and the workflow's own caller grep both stop it.
- The gate fires on legacy functions: `LEGACY` is generated at base, so the first run is green; only new functions
  are held to the rule. `LEGACY` tags are observations, not approvals.
- Retiring a function that is still invoked from outside git (a scheduler, a client build): the workflow only deletes
  after the grep, and the owner approves the step explicitly; redeploy from history restores it.

## 10. Unchanged / out of scope
Every CLOSED item of §1. Tracked residuals, each for its own slice: (a) `switch_to_tenant_by_slug` lookup hardening to
`open_signup AND is_active AND NOT is_platform` (WS3 join flow); (b) `requireAuth` on the dev-sandbox `/debug/memory`
and `/debug/intent` (WS0 route inventory); (c) review of the `C-unreviewed` `LEGACY` functions (WS0); gateway route
inventory and realtime-channel RLS (WS0, `mt-guardrails-r2`); (d) **S-J itself** — the `/debug/*` routes and the
non-private realtime broadcast channels (`docs/MULTI-TENANT-PLAN.md:46`) — stays OPEN, tracked by `mt-guardrails-r2`.
<!-- plan:end -->
