---
change_class: standard
---
# mt-packs (WS5) — Assistant & content packs: Maxina becomes tenant pack #1 — mt-packs-r2 (re-plan)

<!-- plan:begin -->
## Re-plan answers (session `eb308b4e` round 3)
Re-plan of `mt-packs` (branch `kiro/mt-packs/plan`; PLAN-SPAR session `eb308b4e` escalated at the round cap). Every
premise was re-verified on platform `origin/main` `62990ce285` and vitana-v1 `58c76c956` on 2026-11-01. Line refs below
are unchanged unless noted. `buildAnonymousSystemInstruction` ends at `orb-live.ts:7542`, and the file is 19,278
lines.
- **R3-F1** (the guard would scan a pool the lane leaves in place): accepted with option (b). `SHORT_GAP_GREETING_PHRASES`
  is still live and stays untouched in this spec:
  - It is read through `pickShortGapGreetings` (`greeting-pools.ts:195-203`) at `orb-live.ts:10958` and `:11328`,
    where it fills the context's `menuPhrases`.
  - It is pinned by `test/orb/live/characterization/greeting-pools.characterization.test.ts:29` (snapshot).
  - VTID-03630 already turned its consumers into INTENTs (file header `:12-23`).
  - Removing it would change behaviour outside this spec.

  The guard extension is therefore scoped and named exactly. `no-hardcoded-spoken-wording.test.ts` gains one block
  that reads `greeting-pools.ts` and asserts two things: `buildFirstTimeWelcomeLine` is absent, and the four
  first-time welcome literals (`Welcome to Maxina`, `willkommen bei Maxina`, `Bienvenido a Maxina`, `Максину`) are
  gone. It is not a general finished-sentence scan of the file.

  The existing VTID-03742 anonymous-intro checks (`:181-219`) read `orb-live.ts` today. After the verbatim move they
  read `orb/live/instruction/anonymous-system-instruction.ts` instead, so they keep guarding the moved code and cannot
  pass vacuously. Diff item (e) still removes only `buildFirstTimeWelcomeLine` from the `orb-live.ts:413` import.
  The dead `SHORT_GAP_GREETING_PHRASES` import at `:411` is left alone (hot-file cap).
- **R3-F2** (`getTenantIdBySlug` has no `bySlug` primitive): accepted, and the premise is corrected.
  `loadTenantFlags()` (`tenant-context.ts:70`) builds only `byId` (`:79-82`, raw `t.slug ?? ''`).
  - The lookup is owned by `mt-identity-r2` lane `tenant-db-and-slug-cleanup` (its task T3b). It adds a
    `bySlug: Map<string, string>` field to the cache object, filled in the same loop: one `.set` line per row, keyed
    by the lowercased slug, with empty slugs skipped. It also exports `getTenantIdBySlug(slug): Promise<string | null>`.
  - This spec does not edit `tenant-context.ts`. `persona-pack` drops that file from its `paths` and waits for the
    `mt-identity-r2` lane as an external dependency.
  - On the anonymous path, `persona-pack` lowercases the client `tenant_slug` and checks it against
    `^[a-z0-9-]{1,63}$` before any lookup. It then calls `getTenantIdBySlug` and rejects a platform tenant with
    `(await getTenantMeta(id))?.isPlatform`. Any failure returns `null`, which means the Maxina baseline. The null
    fallback contract is unchanged.
- **New lane: WS5 `tenant_content_overrides`.** Program §4 item 5 defines the content pack as repo i18n plus
  `tenant_content_overrides(tenant_id, locale, key, value)`. `mt-launch` publishes into that table (`mt-launch/plan.md`
  Problem 2), and its MIGRATION-QUEUE rows 9–10 (VTID-05324, `20261101110000`/`110100`) require it to be applied
  first. No migration in either repo creates it today, and the old plan had no lane for it.
  - New DB lane `content-overrides-db` creates it at version `20261101100000`. That is before `20261101110000`, so
    timestamp order and queue order agree.
  - Its MIGRATION-QUEUE row goes directly before row 9.
- **Migration versions:** `kb-overlay-db` is independent of `mt-launch`, so it is day-shifted like every multi-tenant
  re-plan (`20261101080000` → `20261102080000`). `content-overrides-db` keeps a `20261101` slot because it must be
  applied before `mt-launch`'s rows.
- **Executors on today's rules:**
  - `whats-new-drafter-prompt` changes `.github/workflows/WHATS-NEW-DRAFT.yml` in vitana-v1. That is a governance path
    but not a protected gate file.
  - It and `whats-new-golden-regen` move from `executor: claude` to `executor: kiro`, with `reviewer_seat:
    agent:vitana-lane-reviewer` (`collaboration.md` §3a). Claude Code is retired.
  - Every lane is reviewed by the reviewer agent.
  - The `v1-golden-edge` fixture and `scripts/mt/golden/` do not exist yet. `mt-guardrails-r2` lane
    `maxina-golden-suite` builds them, and `whats-new-golden-regen` waits for it.
- **Applying migrations:** Kiro applies them through `RUN-MIGRATION.yml`, and only after the owner approves the files
  and the target database (`collaboration.md` §7d). A policy approval never authorises one.

## Problem
Maxina is hardcoded into the assistant and the member-facing copy, so a new tenant cannot get the full
product with its own identity and Maxina's behaviour cannot be golden-tested as "pack #1". Verified 2026-10-15 and re-verified 2026-11-01
(platform `62990ce285`, vitana-v1 `58c76c956`):

1. **Persona is a single hardcoded block.** `services/gateway/src/services/ai-personality-service.ts:86`
   `voice_live.base_identity` begins "You are Vitana, the AI health and wellbeing companion of the **Maxina
   Community** on Vitanaland.com …" — one string mixing the fixed Vitana identity (name, pronunciation, the
   three-names rule, safety, role separation) with the tenant block (community name, anchor person, story,
   offer, tone). `PERSONALITY_DEFAULTS` (`:81`), `PersonalitySurfaceKey` (`:36`) and `VALID_SURFACE_KEYS`
   (`:65`) are the surface list.
2. **`getEffectiveConfig(surfaceKey, tenantId)` already exists** (`ai-personality-service.ts:658`, async) layering
   code default ← global DB (`getPersonalityConfig`) ← tenant override from `tenant_assistant_config`
   (`system_prompt_override`, `voice_config_override`, `tool_overrides`, `model_routing_override`,
   `extra_config`). It is consumed by `routes/tenant-admin/assistant-config.ts:21,62`. **Its tenant override
   replaces `base_identity` WHOLESALE** -- `ai-personality-service.ts:688`
   `merged.base_identity = tenantConfig.system_prompt_override` overwrites the entire string, including the
   fixed Vitana name/pronunciation/three-names/safety rules, not just the tenant block, so the fixed Vitana
   identity is NOT structurally protected by today's merge. The orb profile already carries
   `personaKey: PersonalitySurfaceKey | null` (`orb/profile/role-registry.ts:40`, `assistant-profile.ts:63`);
   `orb/live/surface.ts` imports `PersonalitySurfaceKey` (`:16`) and documents the voice_live overlay (`:63`).
   The live instruction builders do not call `getEffectiveConfig` per tenant. The sync read they use today is
   `getPersonalityConfigSync(surfaceKey)`, DEFINED in `ai-personality-service.ts:460` (imported by
   `live-system-instruction.ts:26`, called at `:576`/`:594`): it reads the module-level `configCache` Map (`:351`,
   30 s TTL `CACHE_TTL_MS` `:344`, `isCacheValid` `:353`) keyed by surface only — there is no per-tenant sync cache
   and no `getEffectiveConfigSync` today.
   The only tenant literal inside `voice_live` defaults is the community clause of `base_identity` (`:86`, community
   name + pronunciation + "Join the Maxina Community"). `tenure_opening_shapes` (`:137`, incl. the `:143` platform
   mission phrase) and `last_interaction_acknowledgements` (`:159`) have no reader in `src/`; the other fields carry
   no tenant literal.
3. **Pre-login story + greetings are Maxina-literal; the anonymous builder is a 128-line hot-file block.**
   `routes/orb-live.ts:7413` `buildAnonymousSystemInstruction` is ~130 lines (`:7413`–`:7542`) inside the
   19k-line `orb-live.ts`, hardcoding the Maxina identity/story (`:7437`, `:7492`) on the UNAUTHENTICATED path —
   no JWT, no resolved `TenantContext` (called `:7651`–`:7652` with `session.clientContext`, no `tenantId`).
   `buildFirstTimeWelcomeLine` (`orb/instruction/greeting-pools.ts:177`) returns FINISHED spoken sentences with
   "Maxina" literals across de/en/es/sr (`:181`–`:186`) — a rule-41 violation, but it is now DEAD on the voice
   path: VTID-04420 replaced its only use with an intent (`services/conversation/compute-greeting-decision.ts:1226-
   1233`), `orb-live.ts:413` only imports it (no call anywhere in `src/`), and only
   `test/orb/instruction/first-time-welcome.test.ts` exercises it (asserting the literal `/Welcome to Maxina/` at
   `:26`). The live first-time welcome is the intent at `compute-greeting-decision.ts:1233` — "Welcome them warmly to
   Maxina" — a hardcoded tenant FACT inside an English intent. The rule-41 guard
   `test/orb/live/characterization/no-hardcoded-spoken-wording.test.ts` reads only `orb-live.ts`,
   `compute-greeting-decision.ts`, `reconnect-recovery-prompt.ts`, `voice-wake-brief.ts` (`:27-39`), not
   `greeting-pools.ts`. All spoken wording must be composed by the model from English INTENTS + FACTS.
   The anonymous session starts at `POST /live/session/start` (`orb-live.ts:16010` → `handleLiveSessionStart`,
   `orb/live/session/live-session-controller.ts:982`; body typed `LiveSessionStartRequest`, `orb/live/types.ts:42`,
   read at `:1099`; `isAnonymousSession = !hasJwtIdentity` `:1161`, stored `isAnonymous` `:1185`). The body has no
   tenant field today.
4. **KB is pinned to one pack.** `kb/instruction-manual/maxina/*` is referenced as the sole manual in
   `orb/live/instruction/live-system-instruction.ts:1282`, `services/orb-tools-shared.ts:1991`,
   `services/retrieval-router.ts:95`, `services/guided-journey/checklist-regenerate.ts:125-131`. No tenant
   overlay on `knowledge_docs`.
5. **Member-facing brand strings are English/Maxina-literal in the frontend.** vitana-v1
   ships ~120 code files / 566 DE lines (+97 EN) of Maxina-named copy; the widget passes no tenant pre-login
   context; `useOrbFrontDoor` is Maxina-shaped. What's New entries (`src/whats-new/entries/*.json`,
   `scripts/whats-new/build-whats-new.mjs`) carry brand names in copy.
6. **Push/email/feature-tips/tool-descriptions** carry Maxina literals server-side (`data/feature-tips.ts`,
   `tt()` catalog, notification copy) with no `{{brand}}` layer.

## Fix
Per lane. All code dark by default behind `MT_RESOLUTION_V2` + `tenant_settings.feature_flags.mt.packs`
unless the lane names an exception; Maxina renders byte-identical (golden equality, WS0 Maxina golden suite).

- **Lane `persona-pack` (kiro, platform gateway).** Split `voice_live.base_identity` (and other surface
  defaults embedding tenant facts) into a FIXED Vitana block (name, pronunciations, three-names, safety, role
  separation — Maxina-free) and a TENANT block assembled at runtime from pack FACTS (community name, anchor,
  story, offer, tone) + English INTENTS. The FIXED block is built from code, never from `system_prompt_override`,
  so a pack supplies only TENANT facts/intents and can never overwrite name/pronunciation/three-names/safety
  (closing the wholesale overwrite at `ai-personality-service.ts:687`); a test asserts it survives a tenant
  override. **FIXED vs TENANT field map (voice_live):** TENANT-driven = ONLY the community clause of
  `base_identity` (`:86`: community name, its pronunciation, the "Join the … Community" example). FIXED = the Vitana
  name/pronunciation/three-names rule of `base_identity` (incl. the platform name "Vitanaland"), `general_behavior`,
  `greeting_rules`, `interruption_handling`, `repetition_prevention`, `tools_section`, `important_section`,
  `role_descriptions`, `forbidden_openings` (`:125`), `silent_honor`, `tenure_opening_shapes` (`:137-154`) and
  `last_interaction_acknowledgements` (`:159-174`) — still globally admin-editable via `ai_personality_config` as
  today, never per tenant pack. The last two have NO reader anywhere in `services/gateway/src` (their only
  occurrences are the definitions `:137`/`:159` and the comment `:157`; the "read by vitana-brain.ts
  buildProactiveGuideBlock" note at `:115-116` is stale — `vitana-brain.ts:539` never reads them), so they reach no
  instruction today and cannot drift Maxina's output; their `:143` "Vitanaland — longevity mission" phrase is
  platform wording. A future reader of these fields must take any tenant fact from the pack (recorded in the lane).
  The golden fixture covers the FULL assembled output of both builders (`buildLiveSystemInstruction`, the extracted
  anonymous builder) and the first-time welcome intent, not just `base_identity`.
  **F1 sync/async:** `buildLiveSystemInstruction` (`live-system-instruction.ts:463`) is SYNC and reads
  `getPersonalityConfigSync` (defined `ai-personality-service.ts:460`, surface-keyed `configCache` `:351`, no tenant
  dimension); it must stay sync (its `orb-live.ts:7678` call site + hot-file §8 cap forbid an async cascade). The
  lane BUILDS the per-tenant primitive in `ai-personality-service.ts` beside `:460`: a second Map
  `tenantConfigCache` keyed `${tenantId}:${surfaceKey}` (same `CACHE_TTL_MS`/`isCacheValid`), filled by a new
  `async prewarmEffectiveConfig(tenantId, surfaces)` that awaits the existing `getEffectiveConfig` (`:658`) and
  stores the merged object, and read by a new `getEffectiveConfigSync(surfaceKey, tenantId)` returning the cached
  merged object, or `getPersonalityConfigSync(surfaceKey)` when `tenantId` is null or the entry is missing/expired
  (= today's output). `prewarmEffectiveConfig` is awaited ONCE in `handleLiveSessionStart`
  (`live-session-controller.ts:982`) after the tenant is known (JWT tenant, or the validated anonymous tenant below),
  in parallel with the existing `clientContextPromise` (`:1025`); the resolved `voice_live` object is stored on the
  session and passed to `buildLiveSystemInstruction` as one new trailing parameter (one-argument call-site change at
  `orb-live.ts:7678`, no `async`). Jest: `getEffectiveConfigSync` returns the tenant-merged config after prewarm, the
  global config with no tenant/expired entry, and builders off the envelope read it synchronously.
  **F2+F3 anonymous:** `buildAnonymousSystemInstruction` (`orb-live.ts:7413-7541`) is first EXTRACTED verbatim into
  `orb/live/instruction/anonymous-system-instruction.ts` (behaviour-identical, snapshot-gated, mirroring the earlier
  `buildLiveSystemInstruction` lift). Exact contract: (1) `LiveSessionStartRequest` (`orb/live/types.ts:42`) gains
  optional `tenant_slug?: string`, sent by the widget (`frontend-brand-neutralise` F2) on `POST /live/session/start`;
  (2) `handleLiveSessionStart` reads it from the body (`:1099`) ONLY when `isAnonymousSession` (`:1161`) — a JWT
  session ignores it (its tenant comes from the token); (3) the server lowercases it and checks it
  against `^[a-z0-9-]{1,63}$`. It then calls `getTenantIdBySlug(slug)`, which is owned by `mt-identity-r2`
  `tenant-db-and-slug-cleanup` T3b: a new `bySlug` map filled in `loadTenantFlags()`'s loop (this spec does not edit
  `tenant-context.ts`, R3-F2). A platform tenant is rejected via `getTenantMeta(id)?.isPlatform`. Any failure gives
  `null`; the slug is never client-trusted and never raises an error; (4) the result is stored on the session as
  `anonTenantId: string | null` (session object `:1185`); (5) the extracted builder's signature becomes
  `buildAnonymousSystemInstruction(lang, voiceStyle, ctx?, conversationHistory?, isReconnect?, tenantId: string |
  null = null)` — `null` renders the Maxina baseline byte-identically. **`orb-live.ts` diff, enumerated against §8:**
  (a) the 128-line body `:7413-7541` moved out (pure deletion of moved code); (b) +1 import line for the extracted
  builder; (c) +1 argument `session.anonTenantId ?? null` at the `:7652` call; (d) +1 argument (the prewarmed
  `voice_live` config) at the `:7678` call; (e) −1 identifier `buildFirstTimeWelcomeLine` from the `:413` import
  list; (f) +1 field line `communityName: session.packFacts.communityName,` in each of the three
  `GreetingDecisionContext` literals (`_baseCtxSF` `:10917`, `_baseCtxSync` `:11297`, `_ctxNS` `:11584` — the only
  places a context is built; `decide-conversation-flow.ts:144` forwards one). Net hand-written change ≤ 8 lines plus
  the verbatim move (§8 cap 20).
  **Pack FACTS on the session:** the tenant block's facts are a typed `PackFacts` object (`communityName` plus the
  other TENANT facts) carried in the effective `voice_live` config as `pack_facts`; code holds Maxina's facts as the
  default (`MAXINA_PACK_FACTS`, `communityName: 'Maxina'`). `handleLiveSessionStart` sets
  `session.packFacts = getEffectiveConfigSync('voice_live', tenantId).pack_facts ?? MAXINA_PACK_FACTS` right after
  the prewarm (tenantId = the JWT tenant, or `anonTenantId`, or null → Maxina).
  **F4 welcome:** `buildFirstTimeWelcomeLine` (`greeting-pools.ts:177-187`) is dead (no `src/` caller; `orb-live.ts:413`
  import only) and is a rule-41 violation, so it is DELETED together with its import and
  `test/orb/instruction/first-time-welcome.test.ts` (which asserts the removed literal). The live first-time welcome
  intent is built inline in the PURE `computeGreetingDecision` (`compute-greeting-decision.ts:699`; impurity injected
  by the caller, header `:21-29`) at `:1232-1237` with the literal "Welcome them warmly to Maxina" (`:1233`), and its
  input `GreetingDecisionContext` (`:238-417`) has no tenant field. The lane therefore (1) adds an OPTIONAL
  `communityName?: string | null` to `GreetingDecisionContext` (optional so every existing test/fixture context still
  type-checks), (2) replaces the `:1233` literal with `${ctx.communityName || 'Maxina'}` — the default reproduces
  today's directive string byte-for-byte, (3) sets it at the three orb-live.ts context literals (diff item (f)). The
  community name is a FACT inside an English INTENT, never a finished sentence. Golden: with no `communityName` and
  with `'Maxina'` the directive equals today's exact string; with a fixture tenant's name it carries that name and
  nothing else changes. `no-hardcoded-spoken-wording.test.ts` gains one scoped block (R3-F1).
  It reads `greeting-pools.ts` and asserts that `buildFirstTimeWelcomeLine` and the four first-time-welcome Maxina
  literals are absent. It runs no general finished-sentence scan, because the live `SHORT_GAP_GREETING_PHRASES` menu
  pool stays out of scope: `pickShortGapGreetings` reads it (`orb-live.ts:10958,11328`) and a snapshot pins it. The
  test's VTID-03742 anonymous-intro checks (`:181-219`) are repointed from `orb-live.ts` to
  `anonymous-system-instruction.ts`.
  Greetings, journey-modes and tool descriptions emit INTENTS only (rule 41). No tenant override → every surface
  byte-identical to today. Reads only; no migration.
- **Lane `content-overrides-db` (kiro, platform supabase/migrations) — WS5, new in the re-plan.**
  - Creates `tenant_content_overrides(tenant_id uuid NOT NULL REFERENCES tenants(id), locale text NOT NULL, key text
    NOT NULL, value text NOT NULL, updated_by uuid NULL, updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY
    (tenant_id, locale, key))`. This is the publish target `mt-launch` writes to
    (`tenant_content_overrides(tenant_id, locale, key, value)`).
  - Access: RLS on, `REVOKE ALL … FROM PUBLIC, anon, authenticated`, `GRANT ALL … TO service_role`. Gateway-only,
    like the `mt-launch` tables.
  - Adds `CHECK (locale ~ '^[a-z]{2}(-[A-Z]{2})?$')`.
  - Version `20261101100000`, before `mt-launch`'s `20261101110000`. Its MIGRATION-QUEUE row goes directly before
    row 9.
  - Rollback is `DROP TABLE`. Pre/post checks are read-only.
  - This spec adds no reader; the reader belongs to the later content-pack serving lane.
- **Lane `kb-overlay-db` (kiro, platform supabase/migrations).** Expand-only migration adding
  `knowledge_docs.tenant_id uuid NULL` (FK `tenants`, context/overlay only; NULL = platform baseline) with
  rollback, `lock_timeout`, read-only pre/post checks, and a MIGRATION-QUEUE row. No backfill of content;
  Maxina's manual stays baseline (NULL).
- **Lane `kb-overlay-code` (kiro, platform gateway).** The baseline-pack-id abstraction does NOT exist today
  (resolve F5): `checklist-regenerate.ts:121` `resolveManualDir()` hardcodes `kb/instruction-manual/maxina`
  across five candidates (`:124`–`:129`), and `retrieval-router.ts:95` / `orb-tools-shared.ts:1991` use the same
  literal — so this lane BUILDS a helper deriving the KB directory from a resolved pack id (default `maxina`,
  directory NOT moved) and updates each consumer to call it. KB resolution reads the baseline then overlays
  `knowledge_docs WHERE tenant_id = ctx.tenantId`; the readers (`retrieval-router.ts`, `orb-tools-shared.ts`,
  `checklist-regenerate.ts`, `live-system-instruction.ts:1282`) pass the resolved tenant. Baseline-only tenants
  (null/`maxina`) behave as today. Depends on `kb-overlay-db`.
- **Lane `brand-content-templating` (kiro, platform gateway).** `{{brand}}` templating ONLY for UI/push/email
  and `tt()` catalog entries (never spoken strings): push copy, feature tips (`data/feature-tips.ts`),
  tool descriptions, server-side notification copy render `{{brand}}` from the resolved tenant brand pack
  (`tenants`/`tenant_settings.brand`), defaulting to Maxina's brand so Maxina output is unchanged.
- **Lane `frontend-brand-neutralise` (kiro, vitana-v1 frontend).** Neutralise user-visible brand strings in
  `src/i18n/{de,en,…}/**` with `{{brand}}` placeholders — DE shard first (du-form), mirrored to en, the other
  9 GA locales via the translation pipeline; keep `/maxina` routes as aliases; widget passes tenant pre-login
  context (host/slug); `useOrbFrontDoor` generic; What's New entry copy (`src/whats-new/entries/*.json`)
  brand-neutralised. Brand resolves to Maxina by default (golden-unchanged).
- **Lane `whats-new-drafter-prompt` (kiro, governance `.github/**`, repo vitana-v1, reviewer agent).** The What's New drafter
  prompt (`.github/workflows/WHATS-NEW-DRAFT.yml`, which exists only in vitana-v1) gains brand-neutral wording.
  It is a governance path but not a protected gate file, so the executor is `kiro`, with the reviewer agent (§3a).
- **Lane `whats-new-golden-regen` (kiro, repo vitana-platform; waits for `mt-guardrails-r2` `maxina-golden-suite`).** CROSS-SPEC O3: regenerate mt-guardrails'
  `v1-golden-edge` fixture (`services/gateway/test/golden/v1-golden-edge.*`, owned by mt-guardrails
  `maxina-golden-suite`) via its documented `scripts/mt/golden/` regenerate script as a declared, reviewed golden
  update reflecting the neutral prompt. Split from the prompt change because a lane is one PR in one repo and
  CROSS-SPEC "never merge across repos"; the cross-repo order (prompt → regen) is a stated reference.

## Migrations
- `20261101100000_mt_packs_tenant_content_overrides.sql` (lane `content-overrides-db`). It sorts before `mt-launch`
  rows 9–10 (`20261101110000`/`110100`), and those rows refuse to apply until it is applied. Rollback: `DROP TABLE`.
- `20261102080000_mt_packs_knowledge_docs_tenant_id.sql` (lane `kb-overlay-db`), range `20261102080000`–
  `20261102085959` (NN=08, day-shifted). Expand-only: `ALTER TABLE knowledge_docs ADD COLUMN tenant_id uuid NULL
  REFERENCES tenants(id)`, nullable, no backfill, no NOT NULL in this program. `lock_timeout` + retries.
  Rollback `docs/validation/<vtid>/rollback.sql` (`DROP COLUMN tenant_id`). Pre-check: column absent;
  post-check: column present, all rows NULL. MIGRATION-QUEUE position: after mt-tenant-admin P2/P3/C3 and the
  moderator-tenant-scope rows (independent; expand-only), within the NN=08 range. Executor renumbers if a
  later migration exists at implementation time.

## Tests
- `persona-pack`: Jest — assembled instruction/intents rendered with Maxina config are byte-identical to
  today (Maxina golden suite); a second fixture tenant's facts produce its block; the FIXED Vitana block
  survives a tenant `system_prompt_override`; the extracted `anonymous-system-instruction.ts` passes a
  behaviour-identity snapshot for Maxina and renders a fixture tenant's facts when a validated slug resolves a
  `tenantId`; `getTenantIdBySlug` returns null for unknown/malformed/platform slugs and the anonymous session
  ignores `tenant_slug` when a JWT is present; `getEffectiveConfigSync` returns the tenant-merged config after
  `prewarmEffectiveConfig` and today's global config otherwise; `no-hardcoded-spoken-wording.test.ts` now also
  scans `greeting-pools.ts` + `anonymous-system-instruction.ts` (and `buildFirstTimeWelcomeLine` +
  `first-time-welcome.test.ts` are removed); the first-time welcome directive (`compute-greeting-decision.ts:1233`) equals today's exact
  string with `communityName` absent or `'Maxina'` and carries a fixture tenant's name otherwise; `npm run test:roles` (42h) green; `npm run test:support` (42c), `npm run test:operator` (42e) green.
- `content-overrides-db`: pgTAP.
  - The table, PK and FK are present.
  - `authenticated` and `anon` cannot SELECT or INSERT; `service_role` can.
  - A bad locale fails the CHECK.
  - `mt-launch`'s existing `test/mt-launch-pack-intake-pgtap.test.ts` stays green.
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
Dark by default (`MT_RESOLUTION_V2`, `tenant_settings.feature_flags.mt.packs`). DB migrations are applied by Kiro
via RUN-MIGRATION after merge, in MIGRATION-QUEUE order. Each one runs only after the owner approves its files and
the target database (§7d), with the lane's read-only pre/post checks. Owner steps: those approvals. The `whats-new-drafter` golden fixture regeneration is a declared reviewed update coordinated
with mt-guardrails. Creating a real tenant pack is a later owner-approved step (not in this slice).

## Risks
- Splitting the persona could drift Maxina's assembled instruction. Mitigation: byte-identical golden fixture
  as the gate; the fixed block is lifted verbatim.
- Rule 41: a refactor could accidentally template a spoken sentence. Mitigation: the rule-41 guard test and
  INTENT-only emission; `{{brand}}` banned from spoken strings by test.
- The existing tenant override overwrites `base_identity` wholesale (`ai-personality-service.ts:687`), which
  could drop the fixed Vitana identity under a tenant pack. Mitigation: the split assembles the fixed block
  from code outside the override path; a test asserts the three-names/safety block survives a tenant override.
- Extracting `buildAnonymousSystemInstruction` from `orb-live.ts` (hot file) could drift the anonymous prompt.
  Mitigation: the extraction is a verbatim behaviour-identical move gated by a snapshot test BEFORE any
  tenant-parameterisation; the `orb-live.ts` edit is a ~3-line import+call swap within the §8 cap.
- An anonymous tenant slug is attacker-controllable. Mitigation: `tenant_slug` is read only for a no-JWT session,
  format-checked, and resolved by `getTenantIdBySlug` against the cached `tenants` list; an unknown/platform slug
  falls back to the Maxina baseline, never errors. It only selects public pack FACTS for the pre-login prompt.
- A stale per-tenant config cache. Mitigation: same 30 s TTL as `configCache`; a miss falls back to today's
  global config, never to another tenant's entry (key includes `tenantId`).
- i18n neutralisation is wide (~120 files). Mitigation: `{{brand}}` default = Maxina; ESLint i18n gate;
  per-shard review; DE-first.
- CROSS-SPEC O3 golden coupling. Mitigation: `whats-new-drafter` depends on mt-guardrails `v1-golden-edge`;
  the fixture regeneration is declared and reviewed in the same PR.

## Out of scope
- `orb-live.ts` edits beyond the enumerated diff (a)–(f) in the persona-pack bullet: the verbatim move of
  `buildAnonymousSystemInstruction`, +1 import, +1 argument at `:7652`, +1 argument at `:7678`, −1 import
  identifier at `:413`, +1 `communityName` field line at each of `:10917`/`:11297`/`:11584` (within the program §8 ≤20-line hot-file cap). No logic is rewritten inside `orb-live.ts`.
- Per-tenant navigation, per-tenant voice persona (M3+).
- Creating a real tenant content pack / Tenant Pack intake (WS8).
- Network/Discover/scope work (mt-network, mt-community-isolation, mt-discover).
- The `platform_only_accounts` view (mt-community-isolation M2) and network groups (mt-network).

## Depends on
- DONE: VTID-05147 (S-M), VTID-05149 (A: `TenantContext`, `is_default`), VTID-05150 (B: brand pack columns,
  `provision_tenant`), VTID-05151 (C: public registry, DB-driven `useTenant`).
- mt-guardrails-r2 (WS0): Maxina golden suite, fixture tenants T_A/T_B, isolation suite, `v1-golden-edge` at
  `services/gateway/test/golden/**` + `scripts/mt/golden/` regenerate script (CROSS-SPEC O3 — `whats-new-golden-regen`
  depends on it), and the pgTAP harness (`pgtap-isolation-suite` runner `scripts/mt/pgtap/run.*` + `ci-wiring`
  `pg_prove` CI install, used by `kb-overlay-db`'s `supabase/tests/mt/` spec).
- mt-identity-r2 (WS1): the resolved `TenantContext`/`tenant_id_for_policies()` used to key `getEffectiveConfig`,
  and `getTenantIdBySlug` from lane `tenant-db-and-slug-cleanup` (T3b). `persona-pack` waits for both.
- Unblocks: `mt-launch` MIGRATION-QUEUE rows 9–10 (VTID-05324), once `content-overrides-db` is applied.

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
