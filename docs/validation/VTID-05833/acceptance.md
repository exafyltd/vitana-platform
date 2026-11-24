# VTID-05833 — preview-gateway-recovery, lane `plan-spar-token`

Plan: `.kiro/specs/preview-gateway-recovery/plan.md` (§6, §7 step 9, §7b), on `main` as `f8b0d187ba` (#5137).
Authority: the owner's instruction of 2026-11-24 naming this plan and the protected file `.github/workflows/PLAN-SPAR.yml`
(quoted in the PR body), Rule 55 break-glass (CLAUDE.md rule 55; the covering sparring is the next full PLAN-SPAR run
through the preview with allocation off), and two reviewer-agent accepts from two different chain models on the
current head (`protected_gate: two-model`, VTID-05765). VTID from the GitLab `vtid-allocate` operation (pipeline 1452).

## What changed
- `.github/workflows/PLAN-SPAR.yml`, step `Spar`, two env lines only:
  - `GATEWAY_SERVICE_TOKEN: ${{ secrets.PLAN_SPAR_GATEWAY_TOKEN || secrets.GATEWAY_SERVICE_TOKEN }}`
  - `PLAN_SPAR_ALLOCATE: ${{ secrets.PLAN_SPAR_GATEWAY_TOKEN == '' && vars.PLAN_SPAR_ALLOCATE || 'false' }}`
- `scripts/collab/plan-spar-preview-token.test.mjs` (new): parses those lines from the workflow and evaluates them with
  Actions `&&`/`||` semantics.

## Acceptance (tasks.md, lane plan-spar-token)

### AC-1 With PLAN_SPAR_GATEWAY_TOKEN set, PLAN-SPAR sends it
TEST: `scripts/collab/plan-spar-preview-token.test.mjs` "the Spar step sends the preview token when it exists, else the shared token".
Evidence: `outputs/green.txt` (3/3), `outputs/red-on-base.txt` (fails on `origin/main`'s workflow), `outputs/yaml-parse.txt`.

### AC-2 Allocation is forced off while the preview token is set
TEST: `scripts/collab/plan-spar-preview-token.test.mjs` "allocation is forced off while the preview token is set; unchanged otherwise".
`plan-spar.mjs:446` allocates only on the exact string `'true'`, so `'false'` and `''` both mean no allocation.

### AC-3 Without the secret, behaviour is identical to today
TEST: `scripts/collab/plan-spar-preview-token.test.mjs` (same case: no preview token → `vars.PLAN_SPAR_ALLOCATE`; shared token sent).
The only visible difference: the env value is `'false'` instead of `''` when the variable is unset; both mean no allocation.

### AC-4 URL, trigger and job condition unchanged; no other gate loosened
TEST: `scripts/collab/plan-spar-preview-token.test.mjs` "the gateway URL, the trigger and the job condition are unchanged".
Evidence: `outputs/collab-green.txt` (every `scripts/collab/*.test.mjs`: 278 tests, 277 pass, 0 fail, 1 skipped), incl. `gate-invariants.test.mjs`.

## Staging
This change deploys no service. Its live proof is the first PLAN-SPAR run after merge (a fresh event on #5135):
session create through `preview-aws-gateway.vitanaland.com` authenticates with the preview token and the run log
shows `PLAN_SPAR_ALLOCATE: false`. That run is also the covering sparring Rule 55 asks for.
