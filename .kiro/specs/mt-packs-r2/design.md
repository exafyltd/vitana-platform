# Design — mt-packs (WS5): Assistant & content packs — mt-packs-r2 (re-plan)

## What exists (read these, do not copy them)
- Program plan + decision register: `docs/MULTI-TENANT-PLAN.md` (§4.5 packs, §6 WS5, D6).
- Migration order, lane version ranges, apply status: `docs/multitenancy/MIGRATION-QUEUE.md`.
- Brand pack columns + `provision_tenant` + public registry: `docs/validation/VTID-05150/**`,
  `docs/validation/VTID-05151/**`, `docs/multitenancy/LANE-C.md`.
- **Persona + effective config:** `services/gateway/src/services/ai-personality-service.ts` —
  `PersonalitySurfaceKey` (36), `PERSONALITY_DEFAULTS` (81), `voice_live.base_identity` with the hardcoded
  "Maxina Community" (86), `VALID_SURFACE_KEYS` (65), `getPersonalityConfig` (373), `getPersonalityConfigSync` (460; surface-keyed `configCache` 351, 30 s TTL 344),
  `getEffectiveConfig(surfaceKey, tenantId)` (658, async; code default ← global DB ← `tenant_assistant_config` override), `getTenantAssistantConfig`
  (719), `upsertTenantAssistantConfig` (742). Consumers: `routes/tenant-admin/assistant-config.ts:21,62`,
  `routes/ai-personality.ts`.
- **Orb profile wiring:** `orb/profile/role-registry.ts` (`personaKey`, `toolPacks`, `knowledgePacks`),
  `orb/profile/assistant-profile.ts` (`personaKey`), `orb/live/surface.ts:64` (`SURFACE_PERSONA_KEY`).
- **Live instruction / pre-login story / greetings:** `orb/live/instruction/live-system-instruction.ts`
  (`buildLiveSystemInstruction`; KB manual reference at 1282), `routes/orb-live.ts:7413`
  `buildAnonymousSystemInstruction` (called 7652), `orb/instruction/greeting-pools.ts` (`buildFirstTimeWelcomeLine` 177 — dead: only imported at
  `orb-live.ts:413`; the live first-time welcome is the intent at `services/conversation/compute-greeting-decision.ts:1233`).
  Anonymous session start: `POST /live/session/start` (`orb-live.ts:16010`) → `handleLiveSessionStart`
  (`orb/live/session/live-session-controller.ts:982`, body `LiveSessionStartRequest` `orb/live/types.ts:42`). Rule-41 guard:
  `test/orb/live/characterization/no-hardcoded-spoken-wording.test.ts` (reads 4 files, `:27-39`).
- **KB manual (baseline):** `services/gateway/src/kb/instruction-manual/maxina/*` (92 chapters); readers
  `live-system-instruction.ts:1282`, `services/orb-tools-shared.ts:1991`, `services/retrieval-router.ts:95`,
  `services/guided-journey/checklist-regenerate.ts:125-131`. Table: `knowledge_docs`.
- **Push / tips / What's New:** `data/feature-tips.ts` (`FEATURE_TIPS`), `services/whats-new-publisher.ts`
  (manifest → cards), `routes/scheduled-notifications.ts` (`/whats-new` 903). The drafter prompt is a workflow:
  `.github/workflows/WHATS-NEW-DRAFT.yml` (governance path).
- **Frontend:** `vitana-v1/src/i18n/{de,en,…}/**` (per-screen shards; DE source of truth), the ORB widget +
  `useOrbFrontDoor`, `src/whats-new/entries/*.json`, `scripts/whats-new/build-whats-new.mjs`.

## persona-pack (platform gateway)
Split `voice_live.base_identity` (and the surface defaults that embed tenant facts) into:
- a FIXED block (Vitana identity, pronunciations, three-names rule, safety, role separation) — lifted verbatim,
  Maxina-free;
- a TENANT block assembled from pack FACTS (`tenant_assistant_config` / brand pack) + English INTENTS.
TENANT = only the community clause of `base_identity`; every other `voice_live` field is FIXED (`tenure_opening_shapes` /
`last_interaction_acknowledgements` have no `src/` reader). The SYNC builders read the tenant block via the new
`getEffectiveConfigSync(surfaceKey, tenantId)` over `tenantConfigCache` (`:`), filled once per session by
`prewarmEffectiveConfig` in `handleLiveSessionStart`; fallback = `getPersonalityConfigSync`. Anonymous: `tenant_slug` on the
session-start body, read only without a JWT, resolved by `getTenantIdBySlug` (`tenancy/tenant-context.ts`) → `session.anonTenantId`
→ the extracted `anonymous-system-instruction.ts` builder's trailing `tenantId`. `buildFirstTimeWelcomeLine` + its test are deleted;
the welcome intent takes the community name as a FACT; the rule-41 guard also reads `greeting-pools.ts`. Greetings/
journey-modes/tool descriptions emit INTENTS (rule 41).
Maxina's facts seed its pack row so the assembled output is byte-identical when no override exists. Hot-file
rule (program §8): `orb-live.ts` touches ≤20 lines in their own PR; the assembly logic lives in
`ai-personality-service.ts` / `live-system-instruction.ts`.

## kb-overlay-db (platform supabase/migrations)
Expand-only `ALTER TABLE knowledge_docs ADD COLUMN tenant_id uuid NULL REFERENCES tenants(id)`; nullable, no
backfill, no NOT NULL. `lock_timeout` + retries; rollback drops the column; pre-check column absent, post-check
column present and all rows NULL. The not-yet-live column is added to `scripts/ci/migration-drift-baseline.json`
and removed in the apply PR (MIGRATION-DRIFT-CHECK pattern).

## kb-overlay-code (platform gateway)
KB resolution: baseline pack id defaults to `maxina` (kept as the neutral baseline id — the directory is not
moved); overlay `knowledge_docs WHERE tenant_id = ctx.tenantId` on top. Readers pass the resolved tenant;
baseline-only tenants resolve unchanged. Depends on `kb-overlay-db`.

## brand-content-templating (platform gateway)
`{{brand}}` templating for push copy, feature tips, tool descriptions and `tt()` catalog entries only; renders
from the resolved tenant brand pack, default Maxina. A guard test bans `{{brand}}` from spoken strings.

## frontend-brand-neutralise (vitana-v1 frontend)
Replace user-visible brand literals with `{{brand}}` across `src/i18n/{de,en,…}/**` (DE first, du-form; en
mirror; 9 GA locales via `scripts/translate-keys.mjs`); widget passes host/slug pre-login; `useOrbFrontDoor`
generic; What's New entry copy neutralised. Brand resolves to Maxina by default.

## whats-new-drafter-prompt (vitana-v1 governance, executor claude)
Brand-neutral drafter prompt in **vitana-v1** `.github/workflows/WHATS-NEW-DRAFT.yml` (the workflow lives only in
vitana-v1; it is absent from vitana-platform). Governance path (`.github/**`) → executor claude (collaboration
§3a, §7).

## whats-new-golden-regen (vitana-platform, executor claude)
CROSS-SPEC O3: regenerate mt-guardrails-r2' `v1-golden-edge` fixture at `services/gateway/test/golden/v1-golden-edge.*`
(the owner's real path — mt-guardrails-r2 `maxina-golden-suite`, not `test/fixtures/`) via mt-guardrails-r2'
`scripts/mt/golden/` regenerate script, as a declared reviewed golden update reflecting the neutral prompt. Split
from the prompt lane because a lane is one PR in one repo and CROSS-SPEC forbids merging across repos; the
cross-repo order (prompt → regen) is a stated reference. Executor claude (cross-spec/fixture-owner coordination).

## Rules every successor follows
1. **Rule 41 (ABSOLUTE):** the assistant never speaks a hardcoded/templated sentence. Spoken output = model-
   composed from FACTS + English INTENTS. `{{brand}}` is for UI/push/email/`tt()` ONLY. A guard test enforces it.
2. **Golden equality:** Maxina's assembled instruction/intents and UI/push/email strings render byte-identical
   to today (WS0 Maxina golden suite); the fixed persona block is lifted verbatim.
3. **Migrations:** apply strictly in `MIGRATION-QUEUE.md` order, one `RUN-MIGRATION.yml` dispatch per file, by
   Kiro only after the owner approves the files and the target database (§7d), with read-only pre/post checks; expand/contract only; a not-yet-live table/column goes in
   `scripts/ci/migration-drift-baseline.json` and is removed after apply. New mt-packs migrations take the next
   version in the `20261102080000`–`20261102085959` (and `content-overrides-db` at `20261101100000`, before mt-launch) range.
4. **Dark by default:** every merged code change is off unless enabled (`MT_RESOLUTION_V2`,
   `tenant_settings.feature_flags.mt.packs`), because PUBLISH promotes the whole staging build.
5. **i18n:** DE shard first (du-form, never Sie/Ihr), mirror to en, other locales via the pipeline; run
   `npm run i18n:inventory`; ESLint `i18n/*` at error level; RTL via logical properties; Spotlight contract; WCAG
   2.2 AA. Dates/numbers via `@/lib/locale-format`.
6. **CROSS-SPEC O3:** `whats-new-golden-regen` depends on mt-guardrails-r2 `v1-golden-edge`
   (`services/gateway/test/golden/v1-golden-edge.*`); its PR regenerates that fixture via mt-guardrails-r2'
   `scripts/mt/golden/` script as a declared, reviewed golden update. The drafter-prompt change is the separate
   vitana-v1 lane `whats-new-drafter-prompt` — never merge the two across repos.
7. **Production is read-only** for every session and test (rules 31–32, 48). The executor never writes to
   Supabase or AWS (collaboration §7a); a DB change is a migration file in the lane PR. D12 one session per VTID;
   D14 auth hook applied by the owner only.
8. Test/service/platform accounts never visible to members (rules 43–45). `npm run test:roles` (42h),
   `npm run test:support` (42c), `npm run test:operator` (42e) stay green when touched.
