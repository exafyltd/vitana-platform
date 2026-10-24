# Internal review (round 3) — mt-packs (WS5): Assistant & content packs

Reviewer: independent adversarial internal reviewer (verdict-writer), session for workflow `wf_997023e6e74c16fa`.
Date: 2026-10-15. Spec: `C:\Users\dstev\vitana-platform-1\.kiro\specs\mt-packs\`.
Method: read the whole spec (plan/requirements/design/tasks/handoff + 7 lane files), the BATCH-BRIEF "Internal
review" criteria and CROSS-SPEC-DECISIONS, verified premises against current code at `file:line`, and ran the
`queue.mjs` validators (`parseFrontMatter` + `validatePlan`/`validateLane`) on `handoff.md` and every `lanes/*.md`.
No spec file was edited; no git was run; no suite was re-run.

## Validator results (queue.mjs) — all clean
`validatePlan(handoff.md)` → `[]`. `validateLane` on all 7 lanes → `[]` each. Front matter parses on every file;
`reviewer_seat ≠ seat` holds everywhere; no governance path appears in a `kiro`-executor lane's `paths`; `executor`,
`next_actor`, `state`, `depends_on` (in-spec ids only) all valid. The two `executor: claude` lanes
(`whats-new-drafter-prompt`, `whats-new-golden-regen`) correctly carry `next_actor: claude` and no `seat`.

## Verified assumptions (checked against current code)
1. **Persona is one hardcoded block** — `services/gateway/src/services/ai-personality-service.ts:86`
   `base_identity: 'You are Vitana, the AI health and wellbeing companion of the Maxina Community on
   Vitanaland.com. …'` — confirmed, mixes fixed Vitana identity + Maxina tenant facts in one string. `PERSONALITY_DEFAULTS`
   (:81), `PersonalitySurfaceKey` (:36), `VALID_SURFACE_KEYS` (:65) confirmed.
2. **`getEffectiveConfig(surfaceKey, tenantId)` exists** at `ai-personality-service.ts:658` (plan says `:659` — a
   one-line drift, NIT below). `getTenantAssistantConfig` at `:717`, `upsertTenantAssistantConfig` at `:741`,
   `getPersonalityConfig` at `:372`. Layering (code default ← global DB ← tenant override) is as the plan states.
3. **`buildAnonymousSystemInstruction`** declared at `routes/orb-live.ts:7413`, called at `:7652` in the anonymous
   branch — confirmed exactly as the plan asserts.
4. **KB readers of `kb/instruction-manual/maxina/*`** confirmed at `retrieval-router.ts:95`,
   `orb-tools-shared.ts:1991`, `checklist-regenerate.ts:125-131`, `live-system-instruction.ts:1282` — all four
   match the plan's citations.
5. **`tt()` catalog** is `services/gateway/src/i18n/catalog.ts` (`export function tt(` at `:369`) — the round-1
   HIGH-4 correction is right; `services/gateway/src/services/i18n/` does not exist.
6. **`brand-content-templating` paths all exist:** `data/feature-tips.ts` ✓, `services/notification-controls/`
   ✓ (`notification-controls-service.ts`, `notification-controls-repository.ts`), `i18n/**` ✓.
7. **`WHATS-NEW-DRAFT.yml` exists only in vitana-v1** (`vitana-v1/.github/workflows/WHATS-NEW-DRAFT.yml`; absent
   from vitana-platform) — the round-1 split (HIGH-1/2/3) is correct, and R5/O3 are framed accordingly.
8. **areas.yaml** — `backoffice` covers only `routes/backoffice-*.ts` / `services/backoffice*/**` and the two
   vitana-v1 backoffice component/page dirs; `frontend` is the vitana-v1 `src/**` catch-all (priority 1). So the
   gateway lanes correctly omit `area`, and `frontend-brand-neutralise` correctly carries `area: frontend`. The
   round-2 removal of the false `area: backoffice` is verified correct.
9. **CROSS-SPEC O3 applied correctly.** The What's New golden coupling is split into `whats-new-drafter-prompt`
   (vitana-v1 `.github/**`, executor claude) and `whats-new-golden-regen` (vitana-platform
   `services/gateway/test/golden/v1-golden-edge.*`, executor claude); the cross-repo order is stated as prose
   because `depends_on` takes in-spec ids only and CROSS-SPEC forbids merging across repos. The fixture path
   `services/gateway/test/golden/` and the `scripts/mt/golden/` regenerate script do not exist yet — correct, they
   are owned by mt-guardrails (WS0) and are declared cross-spec dependencies, not something this spec should own.
10. **Frontend brand literals are real.** 105 `Maxina` occurrences in `vitana-v1/src/i18n/de/**` JSON shards;
    `i18n-source-stamps/` and `src/hooks/useOrbFrontDoor.ts` both exist. The `useOrbFrontDoor` hook carries a
    hardcoded `tenantSlug !== "maxina"` gate — a genuine Maxina-literal in scope.

## Unverified / wrong assumptions
- **`src/components/orb/**` does not exist in vitana-v1.** `src/components/` has no `orb` directory (confirmed:
  `Test-Path .../src/components/orb` → False; the directory listing has `ai`, `assistant`, `vitana`, `vitanaland`
  but no `orb`). The ORB is the EXTERNAL `window.VitanaOrb` widget; its boot/activation/session code lives in
  `src/hooks/useOrbVoiceWidget.ts`, `src/lib/orbActivate.ts`, `src/lib/orbWidgetSession.ts`,
  `src/lib/orbWidgetReady.ts`. See HIGH-1.
- **The `v1-golden-edge` fixture / `scripts/mt/golden/` are not in the tree** — correctly a cross-spec dependency,
  not a defect (see Verified #9).

---

## Findings

### HIGH-1 — `frontend-brand-neutralise` declares a phantom path and omits the files task F2 must change
`lanes/frontend-brand-neutralise.md` (and the matching `tasks.md` "Allowed paths") lists `src/components/orb/**`.
That glob matches **no files** — vitana-v1 has no `src/components/orb/` directory. Meanwhile task F2 requires
"the widget passes tenant pre-login context (host/slug); `useOrbFrontDoor` generic". The ORB widget is the external
`window.VitanaOrb` script; the code that boots it and starts its session (where a host/slug pre-login context
would be injected) is `src/hooks/useOrbVoiceWidget.ts`, `src/lib/orbActivate.ts`, `src/lib/orbWidgetSession.ts`
and `src/lib/orbWidgetReady.ts` — none of which are in the lane's `paths`. Because the PR-GATE **Lane scope** check
(`queue.mjs scope-check`) reds a lane PR that changes any file outside `paths`, F2's widget half cannot be
implemented inside the declared scope: either the executor leaves F2 half-done (only `useOrbFrontDoor.ts`, which
IS listed) or it changes out-of-scope files and fails Lane scope.
**Fix:** in both `lanes/frontend-brand-neutralise.md` `paths` and the `frontend-brand-neutralise` "Allowed paths"
in `tasks.md`, remove `src/components/orb/**` and replace it with the real widget-boot files F2 touches, e.g.:
```
  - src/hooks/useOrbFrontDoor.ts
  - src/hooks/useOrbVoiceWidget.ts
  - src/lib/orbActivate.ts
  - src/lib/orbWidgetSession.ts
  - src/lib/orbWidgetReady.ts
```
(keep only the ones F2 actually edits; drop `src/components/orb/**`). Confirm against the files which of
`orbActivate`/`orbWidgetSession`/`orbWidgetReady` carries the session-start payload before finalising the list.

### NIT-1 (LOW, non-blocking) — one-line drift on the `getEffectiveConfig` citation
Plan ##Problem #2 and `lanes/persona-pack.md` cite `getEffectiveConfig` at `:659`; it is declared at `:658`
(the `export async function getEffectiveConfig(` line). Harmless off-by-one; the symbol and behaviour are correct.
**Fix (optional):** change `:659` → `:658` in `plan.md` and `lanes/persona-pack.md`.

### NIT-2 (LOW, non-blocking) — `brand-content-templating` `i18n/**` glob is broader than the task
The lane `paths` include `services/gateway/src/i18n/**`, but B1 only edits the `tt()` catalog render path. The
broad glob is within one service dir and does not reach a governance path, so Lane scope still protects it; it is
only slightly wider than necessary.
**Fix (optional):** narrow to `services/gateway/src/i18n/catalog.ts` (plus any specific shard the render touches)
if the implementer wants a tighter scope. Not required.

## Open questions for sparring (non-blocking)
- The plan's own two open questions (keep `maxina` as the baseline KB pack id vs. rename to `platform`/`baseline`;
  whether `knowledge_docs.tenant_id` belongs to mt-packs or mt-identity's policy classification) are correctly
  parked here with conservative defaults and do not block.

## Verdict
Round 3 raised one HIGH finding (HIGH-1: phantom path + incomplete `paths` on `frontend-brand-neutralise`, which
broke Lane scope for task F2). The two NITs and the open questions do not block.

### Round 4 (2026-10-15T18:40Z) — HIGH-1 resolved → APPROVED
HIGH-1 fixed: `src/components/orb/**` (confirmed to match no files — vitana-v1 has no `src/components/orb/` dir)
removed from both `lanes/frontend-brand-neutralise.md` `paths` and the `frontend-brand-neutralise` "Allowed paths"
in `tasks.md`; replaced with the real widget-boot files task F2 edits — `src/hooks/useOrbVoiceWidget.ts` (the
`orb.init({ ...initialContext... })` boot/config site, where host/slug pre-login context rides the session start)
and `src/lib/orbActivate.ts` (the external-widget session-start entry points `focusGuidedTopic`/`startGuide`/
`startSupportReport`). `src/lib/orbWidgetSession.ts` and `src/lib/orbWidgetReady.ts` are tiny external-store signal
files carrying no host/slug and were deliberately not added (scope kept to what F2 actually edits). `tasks.md` F2
reworded to name those injection sites. Re-ran the `queue.mjs` validators (`validatePlan`/`validateLane`) on
`handoff.md` and all 7 lanes → `[]` each; `tasks.md` "Allowed paths" == lane `paths` for every lane.

**APPROVED** — no open HIGH/MEDIUM findings; two LOW NITs remain, optional and non-blocking.
