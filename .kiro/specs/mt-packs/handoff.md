---
slug: mt-packs
author: kiro
author_seat: hotmail
executor: kiro
next_actor: claude
state: parked
updated: 2026-10-20T17:11Z
parked_from: drafted
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

### 2026-10-17T16:30Z · kiro-hotmail-202610151618-b437 · replan (evidence_floor_not_met) → drafted
PLAN-SPAR session `a5b179ee-0ba7-4109-afdc-17fbd1b009ad` escalated with `evidence_floor_not_met` (round 1 cited
0 premise checks; infra=false). Re-verified premises against platform tip and refined plan.md with a genuine
finding: the existing `getEffectiveConfig` tenant override **replaces `base_identity` wholesale** at
`services/gateway/src/services/ai-personality-service.ts:687`
(`merged.base_identity = tenantConfig.system_prompt_override`), so the fixed Vitana identity (name,
pronunciation, three-names rule, safety) is NOT structurally protected by the current merge — a tenant pack
could silently drop it. plan.md Problem #2, the `persona-pack` Fix and Risks now require the fixed block to be
assembled from code outside the override path, with a test asserting it survives a tenant override. Also
corrected the imprecise `orb/live/surface.ts:64` citation: `surface.ts` imports `PersonalitySurfaceKey` (`:16`)
and documents the voice_live overlay (`:63`); the `personaKey` field lives on `role-registry.ts:40` /
`assistant-profile.ts:63`. Verified this round via read_file: `ai-personality-service.ts` (`:36/:65/:81/:86`
surface list + hardcoded base_identity, `:659/:687` effective-config merge + wholesale overwrite),
`orb-live.ts:7413/:7652` (`buildAnonymousSystemInstruction`), the four `kb/instruction-manual/maxina` readers
(`live-system-instruction.ts:1282`, `checklist-regenerate.ts:125-129`, `orb-tools-shared.ts:1991`,
`retrieval-router.ts:95`), and `surface.ts:16/:63`. No lane/path/dep change. Next: re-push and re-spar.

### 2026-10-17T16:45Z · kiro-hotmail-202610151618-b437 · spar round 1 (session 1896989e) answered → drafted
Session `1896989e-d566-482a-ae2f-56784ba0d901` round 1: 2 blockers, 2 majors, 1 minor — all ACCEPTED (verified
against the tip), responses in `sparring/s2-responses-1.md`.
- R1-F1 (blocker): `buildLiveSystemInstruction` is sync (`live-system-instruction.ts:463`, reads
  `getPersonalityConfigSync` `:26/:576/:594`); keep it sync and pass a PRE-FETCHED tenant config object in as a
  parameter (call site `orb-live.ts:7678`), plus a `getEffectiveConfigSync` over a session-start cache. No async
  cascade.
- R1-F2 (blocker): `buildAnonymousSystemInstruction` is ~128 lines in `orb-live.ts` (`:7413`–`:7541`); EXTRACT
  it verbatim into `orb/live/instruction/anonymous-system-instruction.ts` (snapshot-gated), leaving a ~3-line
  import+call. Added `services/gateway/src/routes/orb-live.ts` to persona-pack paths + tasks Allowed paths.
- R1-F3 (major): the anonymous path has no `TenantContext` (`orb-live.ts:7651`); the extracted builder takes a
  `tenantId` param populated from a widget slug/host validated server-side against `tenants` (never client-trusted);
  unknown slug → Maxina baseline.
- R1-F4 (major): `buildFirstTimeWelcomeLine` (`greeting-pools.ts:177`, finished Maxina sentences `:181`–`:186`)
  moved into persona-pack scope → FACTS+INTENTS + rule-41 guard + Maxina golden.
- R1-F5 (minor): kb-overlay-code BUILDS the pack-id resolution (`resolveManualDir()` at
  `checklist-regenerate.ts:121` hardcodes the path); no path change (files already scoped), design note added.
Updated plan.md (Problem #3, persona-pack + kb-overlay-code Fix, Tests, Risks, Out of scope), tasks.md
(persona-pack Allowed paths + P2–P5, kb K1), lanes `persona-pack` and `kb-overlay-code`. queue.mjs validators on
handoff.md + all 7 lanes → 0 errors; tasks markers 1:1; Allowed paths == lane paths. Next: push → next round.

### 2026-10-18T19:57Z · ci-plan-spar · escalated (partner unavailable)
The sparring partner could not review (model_unavailable). Not a plan problem: Claude Code looks at the partner, then re-runs.

### 2026-10-18T20:06Z · ci-plan-spar · escalated (partner unavailable)
The sparring partner could not review (model_unavailable). Not a plan problem: Claude Code looks at the partner, then re-runs.

### 2026-10-18T20:14Z · ci-plan-spar · escalated (partner unavailable)
The sparring partner could not review (model_unavailable). Not a plan problem: Claude Code looks at the partner, then re-runs.

### 2026-10-18T20:18Z · ci-plan-spar · escalated (partner unavailable)
The sparring partner could not review (model_unavailable). Not a plan problem: Claude Code looks at the partner, then re-runs.

### 2026-10-18T20:26Z · ci-plan-spar · escalated (partner unavailable)
The sparring partner could not review (model_unavailable). Not a plan problem: Claude Code looks at the partner, then re-runs.

### 2026-10-18T20:39Z · ci-plan-spar · escalated (partner unavailable)
The sparring partner could not review (model_unavailable). Not a plan problem: Claude Code looks at the partner, then re-runs.

### 2026-10-20T17:11Z · ci-plan-spar · drafted → parked
Not converged after 2 sparring sessions (round_cap_reached). Parked with the open findings in sparring/.
