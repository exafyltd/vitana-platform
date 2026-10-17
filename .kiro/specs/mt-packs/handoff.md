---
slug: mt-packs
author: kiro
author_seat: hotmail
executor: kiro
next_actor: claude
state: drafted
updated: 2026-10-17T15:31Z
---
# Handoff — mt-packs (WS5): Assistant & content packs

Planner: Kiro (seat `hotmail`, session `kiro-hotmail-202610151618-b437`, `_plan` claim). This spec splits the
Maxina-hardcoded assistant persona and member-facing copy so Maxina becomes "tenant pack #1" with golden
equality, and a new tenant gets the full assistant/content product with its own identity (program
`docs/MULTI-TENANT-PLAN.md` §4.5, §6 WS5, D6). Plan: `plan.md`. Requirements/design/tasks: `requirements.md`,
`design.md`, `tasks.md`. Cross-spec rulings applied: CROSS-SPEC O3 (`whats-new-drafter` depends on
mt-guardrails `v1-golden-edge`).

Lanes (held at `next_actor: owner` until PLAN-SPAR allocates each VTID and flips it to `kiro`; the
`whats-new-drafter` governance lane is `next_actor: claude`):
- `persona-pack` — platform gateway, seat `jtadic`, reviewer `exafy`. Persona split + runtime
  `getEffectiveConfig`. No migration.
- `kb-overlay-db` — platform supabase/migrations, seat `hotmail`, reviewer `jtadic`. `knowledge_docs.tenant_id`
  expand-only migration (NN=08 range). DB lane, separate from code (§4.7).
- `kb-overlay-code` — platform gateway, seat `jtadic`, reviewer `exafy`. KB baseline + tenant overlay. Depends
  on `kb-overlay-db`.
- `brand-content-templating` — platform gateway, seat `jtadic`, reviewer `exafy`. `{{brand}}` for
  push/email/tips/`tt()` only (rule 41).
- `frontend-brand-neutralise` — vitana-v1 frontend, seat `exafyltd`, reviewer `jtadic`. i18n brand
  neutralisation (DE first), widget pre-login, What's New copy.
- `whats-new-drafter-prompt` — governance `.github/**` in **vitana-v1**, executor `claude`, reviewer `jtadic`.
  Brand-neutral drafter prompt (`WHATS-NEW-DRAFT.yml` lives only in vitana-v1).
- `whats-new-golden-regen` — **vitana-platform**, executor `claude`, reviewer `jtadic`. Regenerate mt-guardrails
  `v1-golden-edge` at `services/gateway/test/golden/**` via its `scripts/mt/golden/` script (CROSS-SPEC O3). Split
  from the prompt lane: never merge across repos.

## Log
### 2026-10-15T16:18Z · kiro-hotmail-202610151618-b437 · created → drafted
Spec drafted and pushed as `plan(mt-packs): …`. Premises verified against platform `C:\Users\dstev\vitana-platform-1`
today: `ai-personality-service.ts:86` (hardcoded "Maxina Community"), `getEffectiveConfig(surfaceKey, tenantId)`
at :659 with `tenant_assistant_config`, `buildAnonymousSystemInstruction` at `orb-live.ts:7413`, KB readers of
`kb/instruction-manual/maxina/*` (`live-system-instruction.ts:1282`, `orb-tools-shared.ts:1991`,
`retrieval-router.ts:95`, `checklist-regenerate.ts:125-131`). Next: PLAN-SPAR spars the plan PR; on converge the
policy approves and VTIDs are allocated (one per lane), lanes flip to `kiro`/`claude`.

### 2026-10-15T18:40Z · kiro-hotmail-202610151618-b437 · internal-review fixes (drafted)
Resolved all internal-review findings (4 HIGH, 1 MEDIUM), re-verified against current code:
- HIGH-1/HIGH-2/HIGH-3: split the former `whats-new-drafter` lane. `WHATS-NEW-DRAFT.yml` exists only in
  **vitana-v1** (confirmed; absent from vitana-platform), so the drafter-prompt change is a vitana-v1 governance
  lane `whats-new-drafter-prompt` (`.github/workflows/WHATS-NEW-DRAFT.yml`, executor claude). The `v1-golden-edge`
  regeneration is a separate **vitana-platform** lane `whats-new-golden-regen` at the owner's real path
  `services/gateway/test/golden/v1-golden-edge.*` (mt-guardrails `maxina-golden-suite` M3, not `test/fixtures/`),
  via mt-guardrails' `scripts/mt/golden/` regenerate script — never merge across repos. O3 wording updated.
- HIGH-4: `brand-content-templating` `tt()` path corrected to `services/gateway/src/i18n/**` (verified: `tt()` is
  in `services/gateway/src/i18n/catalog.ts`; `services/gateway/src/services/i18n/` does not exist).
- MEDIUM-1: `kb-overlay-db` pgTAP spec moved to `supabase/tests/mt/` (mt-guardrails' pgTAP harness directory,
  runner `scripts/mt/pgtap/run.*` + `ci-wiring` `pg_prove`); cross-spec dependency stated. Migration unchanged.
Updated plan.md, tasks.md, handoff.md and the lane files; tasks.md Allowed paths kept identical to lane paths.
Next: re-push the branch (force) and re-spar.

### 2026-10-15T19:05Z · kiro-hotmail-202610151618-b437 · internal-review fix (round 2, drafted)
Internal review round 2 verdict REJECTED on one MEDIUM; one LOW/NIT non-blocking.
- MEDIUM-1: removed the false `area: backoffice` label from `persona-pack`, `kb-overlay-code` and
  `brand-content-templating`. Verified against `docs/programs/areas.yaml`: the `backoffice` area covers only
  `routes/backoffice-*.ts` and `services/backoffice*/**`; none of these lanes' paths match it, and no general
  `gateway` area exists, so by "most specific area wins" they match no area and `area` is omitted (it is optional
  and not validated by `queue.mjs`). `seat: jtadic` is correct (uncovered platform gateway → jtadic) and kept.
  No path, scope, executor or reviewer change.
- NIT-1 (LOW, non-blocking): the mt-guardrails-owned artifacts consumed by `kb-overlay-db` D2 and
  `whats-new-golden-regen` W2 (`v1-golden-edge`, `scripts/mt/golden/`, `supabase/tests/mt/`, `scripts/mt/pgtap/`,
  `pg_prove`, fixture tenants T_A/T_B) are not in the tree yet — correct, they belong to mt-guardrails (WS0) and
  are stated as cross-spec dependencies (`depends_on` takes in-spec ids only, so prose is the right mechanism).
  No mt-packs change; the executor confirms mt-guardrails has landed them before starting those dependent tasks.
Updated the three lane files and handoff.md. Next: re-run the queue.mjs validators, re-push the branch (force),
and re-spar.

### 2026-10-15T19:30Z · kiro-hotmail-202610151618-b437 · internal-review fix (round 4) → APPROVED
Internal review round 3 verdict REJECTED on one HIGH (HIGH-1); round 4 resolves it.
- HIGH-1: `frontend-brand-neutralise` listed `src/components/orb/**`, which matches no files — vitana-v1 has no
  `src/components/orb/` directory (the ORB is the external `window.VitanaOrb` widget). Task F2 ("widget passes
  tenant pre-login context (host/slug)") edits the widget boot code, which was not in `paths`, so PR-GATE Lane
  scope would have redded F2's widget half. Fix: dropped `src/components/orb/**` from the lane `paths` and the
  matching `tasks.md` Allowed paths; added `src/hooks/useOrbVoiceWidget.ts` (the `orb.init({...initialContext...})`
  boot/config site) and `src/lib/orbActivate.ts` (the external-widget session-start entry points). Verified both
  files exist and carry the session-start/init payload; `orbWidgetSession.ts`/`orbWidgetReady.ts` are tiny signal
  stores with no host/slug and were deliberately omitted. tasks.md F2 reworded to name those sites.
Re-ran the `queue.mjs` validators on `handoff.md` and all 7 lanes → 0 errors; `tasks.md` Allowed paths == lane
`paths` for every lane. Internal review now **APPROVED** (two LOW NITs remain, non-blocking). Next: re-push the
branch (force).

### 2026-10-17T14:26Z · ci-plan-spar · escalated (partner unavailable)
The sparring partner could not review (code_access_unavailable). Not a plan problem: Claude Code looks at the partner, then re-runs.

### 2026-10-17T15:31Z · ci-plan-spar · escalated (partner unavailable)
The sparring partner could not review (model_unavailable). Not a plan problem: Claude Code looks at the partner, then re-runs.
