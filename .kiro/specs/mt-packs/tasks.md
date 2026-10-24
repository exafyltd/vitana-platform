# Tasks — mt-packs (WS5): Assistant & content packs

Authoritative plan: `plan.md` (this folder). Lane files: `lanes/`. Each lane adds its own
`docs/validation/<vtid>/` (plan-sparring.md copy, scope.json, staging-tests.json). VTID allocated by PLAN-SPAR
after approval.

<!-- lane: persona-pack -->
## persona-pack — persona split + runtime getEffectiveConfig (repo vitana-platform)
Allowed paths:
- services/gateway/src/services/ai-personality-service.ts
- services/gateway/src/orb/profile/**
- services/gateway/src/orb/live/instruction/**
- services/gateway/src/orb/instruction/greeting-pools.ts
- services/gateway/src/routes/orb-live.ts
- services/gateway/src/orb/live/session/live-session-controller.ts
- services/gateway/src/orb/live/types.ts
- services/gateway/src/services/tenancy/tenant-context.ts
- services/gateway/src/services/conversation/compute-greeting-decision.ts
- services/gateway/test/orb/live/characterization/no-hardcoded-spoken-wording.test.ts
- services/gateway/test/orb/instruction/first-time-welcome.test.ts (deleted)
- services/gateway/test/mt-packs-persona-*.test.ts

- [ ] P1 Split `voice_live.base_identity` into a FIXED Vitana identity block (name, pronunciations, three-names
      rule, platform name, safety, role separation — Maxina-free) and a TENANT block (community name, its
      pronunciation, the "Join the … Community" example) assembled from pack FACTS + English INTENTS. Every other
      `voice_live` field is FIXED per the plan's field map (`tenure_opening_shapes` / `last_interaction_
      acknowledgements` have no `src/` reader today). Maxina's facts seed its pack row.
- [ ] P2 Build the per-tenant sync primitive in `ai-personality-service.ts` beside `getPersonalityConfigSync`
      (`:460`): `tenantConfigCache` keyed `${tenantId}:${surfaceKey}` (same `CACHE_TTL_MS`), filled by
      `async prewarmEffectiveConfig(tenantId, surfaces)` over the existing `getEffectiveConfig` (`:658`), read by
      `getEffectiveConfigSync(surfaceKey, tenantId)` (fallback: `getPersonalityConfigSync`). Await the prewarm once
      in `handleLiveSessionStart` (`live-session-controller.ts:982`, parallel to `clientContextPromise` `:1025`),
      store the resolved `voice_live` object on the session and pass it to the SYNC `buildLiveSystemInstruction`
      (`live-system-instruction.ts:463`) as one trailing parameter — the `orb-live.ts:7678` call gains one
      argument, no `async` cascade (hot-file §8).
- [ ] P3 EXTRACT `buildAnonymousSystemInstruction` (`orb-live.ts:7413-7541`) verbatim into
      `orb/live/instruction/anonymous-system-instruction.ts` (snapshot-gated), signature + trailing
      `tenantId: string | null = null`. Add optional `tenant_slug?: string` to `LiveSessionStartRequest`
      (`orb/live/types.ts:42`); in `handleLiveSessionStart` read it (`:1099`) ONLY for `isAnonymousSession`
      (`:1161`), resolve with new `getTenantIdBySlug(slug)` in `services/tenancy/tenant-context.ts` (a `bySlug` map
      in `loadTenantFlags` `:70-85`; `^[a-z0-9-]{1,63}$`, existing non-platform tenant, else null) and store
      `anonTenantId` on the session (`:1185`); the `orb-live.ts:7652` call gains `session.anonTenantId ?? null`.
      `orb-live.ts` diff is exactly: verbatim move out, +1 import, +1 arg `:7652`, +1 arg `:7678`, −1 import
      identifier `:413`, +1 `communityName: session.packFacts.communityName,` line in each of the three
      `GreetingDecisionContext` literals (`:10917`, `:11297`, `:11584`). After the prewarm set
      `session.packFacts = getEffectiveConfigSync('voice_live', tenantId).pack_facts ?? MAXINA_PACK_FACTS`.
- [ ] P3b Delete the dead rule-41 violation `buildFirstTimeWelcomeLine` (`greeting-pools.ts:177-187`; no `src/`
      caller, `orb-live.ts:413` import only) and `test/orb/instruction/first-time-welcome.test.ts`. In the PURE
      `computeGreetingDecision`: add optional `communityName?: string | null` to `GreetingDecisionContext` (`:238`)
      and replace the `:1233` literal `Maxina` with `${ctx.communityName || 'Maxina'}` (default = today's exact
      directive string). Extend `no-hardcoded-spoken-wording.test.ts` (`:27-39`) to read
      `greeting-pools.ts` and `anonymous-system-instruction.ts`. Greetings/journey-modes/tool descriptions emit
      INTENTS only.
- [ ] P4 Dark by default (`MT_RESOLUTION_V2` + `tenant_settings.feature_flags.mt.packs`): no tenant override →
      every assembled surface (live, anonymous, welcome intent) byte-identical to Maxina today.
- [ ] P5 Tests `services/gateway/test/mt-packs-persona-*.test.ts`: Maxina golden byte-identity of the FULL output
      of both builders + the welcome intent; a fixture tenant's facts produce its block; the FIXED Vitana block
      survives a tenant `system_prompt_override`; `getEffectiveConfigSync` after prewarm / without tenant /
      expired; `getTenantIdBySlug` null for unknown/malformed/platform slugs; a JWT session ignores
      `tenant_slug`; the extracted anonymous builder snapshot is behaviour-identical for Maxina and renders a
      fixture tenant on a validated slug; the extended rule-41 guard; no `{{brand}}` in spoken strings;
      `npm run test:roles` (42h), `npm run test:support` (42c), `npm run test:operator` (42e) green.

Acceptance: all Jest green incl. the three named suites; Maxina golden unchanged; dark by default; PR gate
scope/sparring green; PR title `VTID-xxxxx (mt-packs/persona-pack): …`; commit trailers `Collab-Session` /
`Collab-Lane: mt-packs/persona-pack`. Never writes to a live system.

<!-- lane: kb-overlay-db -->
## kb-overlay-db — knowledge_docs tenant overlay column (repo vitana-platform)
Allowed paths:
- supabase/migrations/20261101080000_mt_packs_knowledge_docs_tenant_id.sql
- supabase/tests/mt/mt_packs_knowledge_docs_tenant_id.sql
- scripts/ci/migration-drift-baseline.json
- docs/multitenancy/MIGRATION-QUEUE.md

- [ ] D1 Expand-only migration: `ALTER TABLE knowledge_docs ADD COLUMN tenant_id uuid NULL REFERENCES
      tenants(id)`; nullable; no backfill; no NOT NULL. `SET lock_timeout`; retry note in the file header.
- [ ] D2 pgTAP `supabase/tests/mt/mt_packs_knowledge_docs_tenant_id.sql` (mt-guardrails' pgTAP harness
      directory — `scripts/mt/pgtap/run.*` runner + `ci-wiring` `pg_prove` install): column exists, nullable,
      FK present; a NULL (baseline) row resolves. Cross-spec dependency on mt-guardrails for the runner/CI
      install (stated in plan.md ## Depends on; `depends_on` takes in-spec ids only).
- [ ] D3 Add the not-yet-live column to `scripts/ci/migration-drift-baseline.json`; add the MIGRATION-QUEUE row
      (position: NN=08 range, after mt-tenant-admin P2/P3/C3 + moderator-tenant-scope; independent, expand-only;
      rollback `docs/validation/<vtid>/rollback.sql`, read-only pre/post checks). Executor renumbers if a later
      migration exists at implementation time. The apply (RUN-MIGRATION) and baseline removal are done by Claude.

Acceptance: migration lints/applies cleanly on the local stack dry-run; pgTAP green; drift baseline + queue row
present; this lane adds `docs/validation/<vtid>/{plan-sparring.md,scope.json,staging-tests.json,rollback.sql}`.
PR title `VTID-xxxxx (mt-packs/kb-overlay-db): …`; trailers `Collab-Session` / `Collab-Lane: mt-packs/kb-overlay-db`.
Never applies the migration against a live system.

<!-- lane: kb-overlay-code -->
## kb-overlay-code — KB baseline + tenant overlay resolution (repo vitana-platform)
Allowed paths:
- services/gateway/src/services/retrieval-router.ts
- services/gateway/src/services/orb-tools-shared.ts
- services/gateway/src/services/guided-journey/checklist-regenerate.ts
- services/gateway/src/orb/live/instruction/live-system-instruction.ts
- services/gateway/test/mt-packs-kb-overlay-*.test.ts

- [ ] K1 BUILD the pack-id resolution the plan assumes (it does not exist today): a single helper derives the
      KB directory from a resolved pack id (default `maxina`, directory NOT moved), replacing the hardcoded
      `kb/instruction-manual/maxina` in `checklist-regenerate.ts:121` `resolveManualDir()` (`:124`–`:129`),
      `retrieval-router.ts:95` and `orb-tools-shared.ts:1991`. KB resolution then reads the baseline and overlays
      `knowledge_docs WHERE tenant_id = ctx.tenantId`.
- [ ] K2 Readers (`retrieval-router.ts`, `orb-tools-shared.ts`, `checklist-regenerate.ts`,
      `live-system-instruction.ts`) pass the resolved tenant; baseline-only tenants resolve unchanged.
- [ ] K3 Tests `services/gateway/test/mt-packs-kb-overlay-*.test.ts`: baseline-only resolves Maxina manual
      unchanged; a fixture tenant's overlay doc is preferred; no cross-tenant overlay leak (WS0 isolation).

Acceptance: Jest green; Maxina baseline unchanged; depends on kb-overlay-db (column present). PR title
`VTID-xxxxx (mt-packs/kb-overlay-code): …`; trailers `Collab-Session` / `Collab-Lane: mt-packs/kb-overlay-code`.
Never writes to a live system.

<!-- lane: brand-content-templating -->
## brand-content-templating — {{brand}} for push/email/tips/tt() (repo vitana-platform)
Allowed paths:
- services/gateway/src/data/feature-tips.ts
- services/gateway/src/services/notification-controls/**
- services/gateway/src/i18n/**
- services/gateway/test/mt-packs-brand-templating-*.test.ts

- [ ] B1 Render `{{brand}}` from the resolved tenant brand pack in push copy, feature tips, tool descriptions
      and `tt()` catalog entries; default to Maxina's brand when unresolved (output unchanged).
- [ ] B2 Guard: `{{brand}}` is never used in a spoken string (rule 41) — a test fails the build if it is.
- [ ] B3 Tests `services/gateway/test/mt-packs-brand-templating-*.test.ts`: `{{brand}}` renders the tenant
      brand; Maxina default byte-identical; the rule-41 guard.

Acceptance: Jest green; Maxina default unchanged. PR title `VTID-xxxxx (mt-packs/brand-content-templating): …`;
trailers `Collab-Session` / `Collab-Lane: mt-packs/brand-content-templating`. Never writes to a live system.

<!-- lane: frontend-brand-neutralise -->
## frontend-brand-neutralise — i18n brand neutralisation + widget + What's New (repo vitana-v1)
Allowed paths:
- src/i18n/**
- src/hooks/useOrbFrontDoor.ts
- src/hooks/useOrbVoiceWidget.ts
- src/lib/orbActivate.ts
- src/whats-new/entries/**
- i18n-source-stamps/**
- docs/SCREEN_INVENTORY.md

- [ ] F1 Replace user-visible brand literals with `{{brand}}` across `src/i18n/de/**` FIRST (du-form, never
      Sie/Ihr), mirror to `src/i18n/en/**`; the other 9 GA locales via `scripts/translate-keys.mjs`. Keep
      `/maxina` routes as aliases (no route removal → no nav-registry/manifest/parity change).
- [ ] F2 Widget passes tenant pre-login context (host/slug): inject it where the external `window.VitanaOrb`
      widget is booted/configured (`src/hooks/useOrbVoiceWidget.ts`, `orb.init(... initialContext ...)`) and its
      session-start entry points (`src/lib/orbActivate.ts`), sent as `tenant_slug` in the
      `POST /live/session/start` body (contract owned by persona-pack P3); `useOrbFrontDoor` generic; What's New entry copy
      (`src/whats-new/entries/*.json`) brand-neutralised. Brand resolves to Maxina by default.
- [ ] F3 `npm run i18n:inventory` (commit `docs/SCREEN_INVENTORY.md`); ESLint `i18n/*` + `design/*` clean on
      changed files; `npm test` (nav registry / design manifest unaffected).

Acceptance: Vitest + ESLint i18n/design green; DE du-form; brand default Maxina (golden-unchanged). PR title
`VTID-xxxxx (mt-packs/frontend-brand-neutralise): …`; trailers `Collab-Session` /
`Collab-Lane: mt-packs/frontend-brand-neutralise`. Never writes to a live system.

<!-- lane: whats-new-drafter-prompt -->
## whats-new-drafter-prompt — brand-neutral drafter prompt (repo vitana-v1, executor claude)
Allowed paths:
- .github/workflows/WHATS-NEW-DRAFT.yml

- [ ] W1 Make the What's New drafter prompt brand-neutral in vitana-v1's `.github/workflows/WHATS-NEW-DRAFT.yml`
      (the workflow exists only in vitana-v1). Drop the hardcoded brand name so a drafted entry is brand-neutral;
      the `{{brand}}` layer supplies the tenant brand at render time.

Acceptance: the drafter prompt no longer hardcodes the brand; governance path (`.github/**`) → executor claude.
PR title `VTID-xxxxx (mt-packs/whats-new-drafter-prompt): …`; trailers `Collab-Session` /
`Collab-Lane: mt-packs/whats-new-drafter-prompt`.

<!-- lane: whats-new-golden-regen -->
## whats-new-golden-regen — regenerate v1-golden-edge fixture (repo vitana-platform, executor claude)
Allowed paths:
- services/gateway/test/golden/v1-golden-edge.*

- [ ] W2 CROSS-SPEC O3: regenerate mt-guardrails' `v1-golden-edge` fixture
      (`services/gateway/test/golden/v1-golden-edge.*`, owned by mt-guardrails `maxina-golden-suite`) as a
      declared, reviewed golden update reflecting the neutral drafter prompt, using mt-guardrails' documented
      regenerate script in `scripts/mt/golden/` (not a hand-edit, not a second fixture location). mt-guardrails'
      golden suite (`mt-maxina-golden.test.ts`) passes against the regenerated fixture. Cross-repo ordering vs
      `whats-new-drafter-prompt` (vitana-v1) is a stated reference, not a `depends_on` id.

Acceptance: the regenerated fixture at `services/gateway/test/golden/v1-golden-edge.*` is committed and
mt-guardrails' golden suite is green; cross-spec coordination → executor claude. PR title
`VTID-xxxxx (mt-packs/whats-new-golden-regen): …`; trailers `Collab-Session` /
`Collab-Lane: mt-packs/whats-new-golden-regen`.
