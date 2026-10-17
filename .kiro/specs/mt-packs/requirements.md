# Requirements — mt-packs (WS5): Assistant & content packs

Program: `C:\Users\dstev\AppData\Local\Temp\mt-plan\MULTI-TENANT-PLAN.md` (v5.1, owner-approved 2026-10-10;
decision register at its end) — in the repo, `docs/MULTI-TENANT-PLAN.md`. This spec links the program's records
instead of copying them. Cross-spec rulings: `CROSS-SPEC-DECISIONS.md` (binding).

## Program position
- **Predecessors (DONE, in production):** VTID-05147 (S-M), VTID-05149 (A: `TenantContext`, `tenants.is_default`),
  VTID-05150 (B: brand pack columns, `provision_tenant`), VTID-05151 (C: public registry, DB-driven `useTenant`).
  Records: `docs/validation/VTID-0514{7,9}/**`, `docs/validation/VTID-0515{0,1}/**`,
  `docs/multitenancy/LANE-C.md`, `docs/multitenancy/MIGRATION-QUEUE.md`.
- **Depends on (concurrent specs):** mt-guardrails (WS0 — Maxina golden suite, fixture tenants T_A/T_B, isolation
  suite, `v1-golden-edge` fixture); mt-identity (WS1 — resolved `TenantContext` / `tenant_id_for_policies()`).
- **Successors:** mt-frontend-brand (WS7 rest — theme/assets/CORS/emails), mt-jobs (WS6 — per-tenant job loops),
  mt-launch (WS8 — Tenant Pack intake / content pipeline).

## Program goal (links, not copies)
Maxina becomes "tenant #1 with a content pack", not the template (program §1, §4.5). A new tenant gets the full
assistant and member-facing product with its own identity, Maxina's behaviour unchanged and golden-tested.

## This spec (WS5 — program §6 "WS5 Assistant & content packs")

### R1 — Persona split (lane `persona-pack`)
1. THE assistant persona SHALL be composed at runtime from a FIXED Vitana identity block (name, pronunciations,
   three-names rule, safety, role separation) and a TENANT block (community name + pronunciation, anchor person,
   story, offer, tone) resolved through `getEffectiveConfig(surfaceKey, tenantId)`.
2. THE tenant block SHALL be assembled from pack FACTS and English INTENTS only; THE SYSTEM SHALL NEVER emit a
   templated spoken sentence (CLAUDE.md rule 41). `{{brand}}` SHALL NOT appear in any spoken string.
3. WHEN no tenant override exists THE assembled instruction/intents SHALL be byte-identical to today's Maxina
   output (Maxina golden suite; `npm run test:roles` 42h green).

### R2 — KB baseline + tenant overlay (lanes `kb-overlay-db`, `kb-overlay-code`)
1. `knowledge_docs` SHALL gain a nullable `tenant_id` (overlay/context; NULL = platform baseline) via an
   expand-only migration with a rollback and read-only pre/post checks, in MIGRATION-QUEUE order.
2. KB resolution SHALL read the platform baseline (`kb/instruction-manual/<pack>`) then overlay
   `knowledge_docs WHERE tenant_id = ctx.tenantId`; a baseline-only tenant SHALL resolve exactly as today.
3. A tenant SHALL NEVER read another tenant's overlay docs (WS0 isolation).

### R3 — Brand templating for UI/push/email (lane `brand-content-templating`)
1. Push copy, feature tips, tool descriptions and `tt()` catalog entries SHALL render `{{brand}}` from the
   resolved tenant brand pack; WHEN unresolved THE brand SHALL default to Maxina (output unchanged).
2. `{{brand}}` SHALL be used ONLY for UI/push/email/`tt()` — never for a spoken string (rule 41).

### R4 — Frontend brand neutralisation (lane `frontend-brand-neutralise`)
1. EVERY user-visible brand string in `src/i18n/{de,en,…}/**` SHALL be a `{{brand}}` placeholder; THE DE shard
   SHALL be edited first (du-form), mirrored to en, other GA locales via the pipeline; `/maxina` routes stay as
   aliases.
2. THE widget SHALL pass tenant pre-login context (host/slug); `useOrbFrontDoor` SHALL be generic; What's New
   entry copy SHALL be brand-neutralised. Default brand = Maxina (golden-unchanged).

### R5 — What's New drafter (lanes `whats-new-drafter-prompt`, `whats-new-golden-regen`, both executor claude)
1. THE What's New drafter prompt in **vitana-v1** `.github/workflows/WHATS-NEW-DRAFT.yml` SHALL be brand-neutral
   (lane `whats-new-drafter-prompt`; the workflow exists only in vitana-v1).
2. PER CROSS-SPEC O3, lane `whats-new-golden-regen` SHALL regenerate mt-guardrails' `v1-golden-edge` fixture at
   `services/gateway/test/golden/v1-golden-edge.*` (vitana-platform) via mt-guardrails' `scripts/mt/golden/`
   regenerate script, as a declared, reviewed golden update. THE two actions SHALL be separate lanes/PRs because
   a lane is one PR in one repo and CROSS-SPEC forbids merging across repos.

## Not in this spec
`orb-live.ts` large edits (hot-file rule, program §8); per-tenant navigation / voice persona (M3+); creating a
real tenant content pack / Tenant Pack intake (WS8); Network/Discover/scope (mt-network, mt-community-isolation,
mt-discover); `platform_only_accounts` view (mt-community-isolation M2); network groups (mt-network). Each later
slice is sparred and approved on its own.
