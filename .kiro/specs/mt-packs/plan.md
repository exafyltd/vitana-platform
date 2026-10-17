---
change_class: standard
---
# mt-packs (WS5) — Assistant & content packs: Maxina becomes tenant pack #1

<!-- plan:begin -->
## Problem
Maxina is hardcoded into the assistant and the member-facing copy, so a new tenant cannot get the full
product with its own identity and Maxina's behaviour cannot be golden-tested as "pack #1". Verified today
(2026-10-15, platform `C:\Users\dstev\vitana-platform-1`, frontend `C:\Users\dstev\vitana-v1`):

1. **Persona is a single hardcoded block.** `services/gateway/src/services/ai-personality-service.ts:86`
   `voice_live.base_identity` begins "You are Vitana, the AI health and wellbeing companion of the **Maxina
   Community** on Vitanaland.com …" — one string mixing the fixed Vitana identity (name, pronunciation, the
   three-names rule, safety, role separation) with the tenant block (community name, anchor person, story,
   offer, tone). `PERSONALITY_DEFAULTS` (`:81`), `PersonalitySurfaceKey` (`:36`) and `VALID_SURFACE_KEYS`
   (`:65`) are the surface list.
2. **`getEffectiveConfig(surfaceKey, tenantId)` already exists** (`ai-personality-service.ts:659`) layering
   code default ← global DB (`getPersonalityConfig`) ← tenant override from `tenant_assistant_config`
   (`system_prompt_override`, `voice_config_override`, `tool_overrides`, `model_routing_override`,
   `extra_config`). It is consumed by `routes/tenant-admin/assistant-config.ts:21,62`. The orb profile
   already carries `personaKey: PersonalitySurfaceKey | null` (`orb/profile/role-registry.ts:40`,
   `assistant-profile.ts:63`, `orb/live/surface.ts:64`), but the live instruction builders do not call
   `getEffectiveConfig` per tenant.
3. **Pre-login story + greetings are Maxina-literal.** `routes/orb-live.ts:7413`
   `buildAnonymousSystemInstruction(lang, voiceStyle, ctx, …)` (called `:7652`) and the greeting pools
   (`orb/instruction/greeting-pools.ts`) hardcode the Maxina story/offer. Rule 41: these are composed by the
   model from English INTENTS + FACTS — never templated spoken sentences.
4. **KB is pinned to one pack.** `kb/instruction-manual/maxina/*` is referenced as the sole manual in
   `orb/live/instruction/live-system-instruction.ts:1282`, `services/orb-tools-shared.ts:1991`,
   `services/retrieval-router.ts:95`, `services/guided-journey/checklist-regenerate.ts:125-131`. No tenant
   overlay on `knowledge_docs`.
5. **Member-facing brand strings are English/Maxina-literal in the frontend.** `C:\Users\dstev\vitana-v1`
   ships ~120 code files / 566 DE lines (+97 EN) of Maxina-named copy; the widget passes no tenant pre-login
   context; `useOrbFrontDoor` is Maxina-shaped. What's New entries (`src/whats-new/entries/*.json`,
   `scripts/whats-new/build-whats-new.mjs`) carry brand names in copy.
6. **Push/email/feature-tips/tool-descriptions** carry Maxina literals server-side (`data/feature-tips.ts`,
   `tt()` catalog, notification copy) with no `{{brand}}` layer.

## Fix
Per lane. All code dark by default behind `MT_RESOLUTION_V2` + `tenant_settings.feature_flags.mt.packs`
unless the lane names an exception; Maxina renders byte-identical (golden equality, WS0 Maxina golden suite).

- **Lane `persona-pack` (kiro, platform gateway).** Split `voice_live.base_identity` (and the other surface
  defaults that embed tenant facts) into a FIXED Vitana identity block (name, pronunciations, three-names
  rule, safety, role separation — unchanged, Maxina-free) and a TENANT block assembled at runtime from pack
  FACTS (community name + pronunciation, anchor person, story, offer, tone) and English INTENTS. The live
  instruction builders (`buildLiveSystemInstruction`, `buildAnonymousSystemInstruction` in `routes/orb-live.ts`,
  via `orb/live/instruction/live-system-instruction.ts`) resolve the tenant block through
  `getEffectiveConfig(surfaceKey, ctx.tenantId)` keyed on the resolved `TenantContext`. Greetings,
  journey-modes, first-time welcome and tool descriptions emit INTENTS, never finished sentences (rule 41).
  Maxina's facts live in its pack row; with no tenant override the assembled block is byte-identical to
  today. Reads only; no migration.
- **Lane `kb-overlay-db` (kiro, platform supabase/migrations).** Expand-only migration adding
  `knowledge_docs.tenant_id uuid NULL` (FK `tenants`, context/overlay only; NULL = platform baseline) with
  rollback, `lock_timeout`, read-only pre/post checks, and a MIGRATION-QUEUE row. No backfill of content;
  Maxina's manual stays baseline (NULL).
- **Lane `kb-overlay-code` (kiro, platform gateway).** KB resolution reads the platform baseline
  (`kb/instruction-manual/<pack>`, default `maxina` kept as the baseline pack id) then overlays
  `knowledge_docs WHERE tenant_id = ctx.tenantId` on top; retrieval/knowledge packs
  (`orb/profile/role-registry.ts` `knowledgePacks`, `services/retrieval-router.ts`,
  `services/orb-tools-shared.ts`, `checklist-regenerate.ts`) pass the resolved tenant. Baseline-only tenants
  behave exactly as today. Depends on `kb-overlay-db`.
- **Lane `brand-content-templating` (kiro, platform gateway).** `{{brand}}` templating ONLY for UI/push/email
  and `tt()` catalog entries (never spoken strings): push copy, feature tips (`data/feature-tips.ts`),
  tool descriptions, server-side notification copy render `{{brand}}` from the resolved tenant brand pack
  (`tenants`/`tenant_settings.brand`), defaulting to Maxina's brand so Maxina output is unchanged.
- **Lane `frontend-brand-neutralise` (kiro, vitana-v1 frontend).** Neutralise user-visible brand strings in
  `src/i18n/{de,en,…}/**` with `{{brand}}` placeholders — DE shard first (du-form), mirrored to en, the other
  9 GA locales via the translation pipeline; keep `/maxina` routes as aliases; widget passes tenant pre-login
  context (host/slug); `useOrbFrontDoor` generic; What's New entry copy (`src/whats-new/entries/*.json`)
  brand-neutralised. Brand resolves to Maxina by default (golden-unchanged).
- **Lane `whats-new-drafter-prompt` (claude, governance `.github/**`, repo vitana-v1).** The What's New drafter
  prompt (`.github/workflows/WHATS-NEW-DRAFT.yml`, which exists only in vitana-v1) gains brand-neutral wording.
  Governance path → executor claude.
- **Lane `whats-new-golden-regen` (claude, repo vitana-platform).** CROSS-SPEC O3: regenerate mt-guardrails'
  `v1-golden-edge` fixture (`services/gateway/test/golden/v1-golden-edge.*`, owned by mt-guardrails
  `maxina-golden-suite`) via its documented `scripts/mt/golden/` regenerate script as a declared, reviewed golden
  update reflecting the neutral prompt. Split from the prompt change because a lane is one PR in one repo and
  CROSS-SPEC "never merge across repos"; the cross-repo order (prompt → regen) is a stated reference.

## Migrations
- `20261101080000_mt_packs_knowledge_docs_tenant_id.sql` (lane `kb-overlay-db`), range `20261101080000`–
  `20261101085959` (NN=08). Expand-only: `ALTER TABLE knowledge_docs ADD COLUMN tenant_id uuid NULL
  REFERENCES tenants(id)`, nullable, no backfill, no NOT NULL in this program. `lock_timeout` + retries.
  Rollback `docs/validation/<vtid>/rollback.sql` (`DROP COLUMN tenant_id`). Pre-check: column absent;
  post-check: column present, all rows NULL. MIGRATION-QUEUE position: after mt-tenant-admin P2/P3/C3 and the
  moderator-tenant-scope rows (independent; expand-only), within the NN=08 range. Executor renumbers if a
  later migration exists at implementation time.

## Tests
- `persona-pack`: Jest — assembled instruction/intents rendered with Maxina config are byte-identical to
  today (Maxina golden suite); a second fixture tenant's facts produce its block; no finished spoken sentence
  is emitted (rule 41 guard); `npm run test:roles` (42h) green; `npm run test:support` (42c),
  `npm run test:operator` (42e) green.
- `kb-overlay-db`: pgTAP (`supabase/tests/mt/`, run by mt-guardrails' `scripts/mt/pgtap/run.*` + CI `pg_prove`
  from `ci-wiring`) — column exists, nullable, FK present; a baseline (NULL) doc still resolves.
- `kb-overlay-code`: Jest — baseline-only tenant resolves Maxina manual unchanged; an overlay doc for a
  fixture tenant is preferred; cross-tenant overlay never leaks (WS0 isolation).
- `brand-content-templating`: Jest — `{{brand}}` renders the tenant brand; Maxina default byte-identical;
  no `{{brand}}` reaches a spoken string.
- `frontend-brand-neutralise`: Vitest — i18n keys resolve with `{{brand}}`; ESLint i18n (no raw JSX text) +
  design clean on changed files; DE du-form; `npm run i18n:inventory`; `npm test` (nav registry/manifest
  unaffected).
- `whats-new-drafter-prompt`: the drafter prompt reads brand-neutral (vitana-v1 workflow).
- `whats-new-golden-regen`: the regenerated `services/gateway/test/golden/v1-golden-edge.*` fixture is committed
  and mt-guardrails' golden suite passes against it; declared golden update.

## Staging verification
Read-only (rule 48): staging specs sign in and read; Maxina surfaces render byte-identical (golden parity on
staging); the persona/KB/brand paths are proven by Jest/Vitest (staging writes to production Supabase, so no
tenant override is created on staging). Network guard aborts non-GET.

## Rollout
Dark by default (`MT_RESOLUTION_V2`, `tenant_settings.feature_flags.mt.packs`). DB migration applied by Claude
via RUN-MIGRATION after merge, in MIGRATION-QUEUE order, with the lane's read-only pre/post checks. No
owner-only steps. The `whats-new-drafter` golden fixture regeneration is a declared reviewed update coordinated
with mt-guardrails. Creating a real tenant pack is a later owner-approved step (not in this slice).

## Risks
- Splitting the persona could drift Maxina's assembled instruction. Mitigation: byte-identical golden fixture
  as the gate; the fixed block is lifted verbatim.
- Rule 41: a refactor could accidentally template a spoken sentence. Mitigation: the rule-41 guard test and
  INTENT-only emission; `{{brand}}` banned from spoken strings by test.
- i18n neutralisation is wide (~120 files). Mitigation: `{{brand}}` default = Maxina; ESLint i18n gate;
  per-shard review; DE-first.
- CROSS-SPEC O3 golden coupling. Mitigation: `whats-new-drafter` depends on mt-guardrails `v1-golden-edge`;
  the fixture regeneration is declared and reviewed in the same PR.

## Out of scope
- `orb-live.ts` large edits beyond ≤20-line hot-file touches (program §8 hot-file rule).
- Per-tenant navigation, per-tenant voice persona (M3+).
- Creating a real tenant content pack / Tenant Pack intake (WS8).
- Network/Discover/scope work (mt-network, mt-community-isolation, mt-discover).
- The `platform_only_accounts` view (mt-community-isolation M2) and network groups (mt-network).

## Depends on
- DONE: VTID-05147 (S-M), VTID-05149 (A: `TenantContext`, `is_default`), VTID-05150 (B: brand pack columns,
  `provision_tenant`), VTID-05151 (C: public registry, DB-driven `useTenant`).
- mt-guardrails (WS0): Maxina golden suite, fixture tenants T_A/T_B, isolation suite, `v1-golden-edge` at
  `services/gateway/test/golden/**` + `scripts/mt/golden/` regenerate script (CROSS-SPEC O3 — `whats-new-golden-regen`
  depends on it), and the pgTAP harness (`pgtap-isolation-suite` runner `scripts/mt/pgtap/run.*` + `ci-wiring`
  `pg_prove` CI install, used by `kb-overlay-db`'s `supabase/tests/mt/` spec).
- mt-identity (WS1): resolved `TenantContext`/`tenant_id_for_policies()` used to key `getEffectiveConfig`.

## Owner decisions
D6 (DECIDED): shared content, `{{brand}}` only for UI/push/email/`tt()`, facts+intents for the assistant
(rule 41), per-tenant overrides. No new decision.
<!-- plan:end -->

## Open questions for sparring
- Baseline KB pack id: keep the directory name `maxina` as the neutral baseline pack id, or rename to
  `platform`/`baseline` (cross-spec with any KB path consumer)? Default: keep `maxina` as the baseline id to
  avoid moving ~92 chapters and touching four readers; the tenant overlay is additive. Does not block.
- Whether the `knowledge_docs.tenant_id` overlay belongs to mt-packs or to mt-identity's policy
  classification (health-table-style context column). Default: mt-packs owns the column (overlay semantics
  are a packs concern); mt-identity classifies its RLS when it rewrites policies.
