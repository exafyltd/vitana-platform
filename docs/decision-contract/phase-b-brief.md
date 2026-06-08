# Decision-Contract Phase B Brief — Externalize Policy

**Status:** ready to start
**Predecessor:** Phase A (VTID-03109, merged 2026-05-20 as `4cf06776`) — see `services/gateway/src/services/decision-contract/`
**This brief lives at:** `docs/decision-contract/phase-b-brief.md` (VTID-03111)

---

## How to use this document

If you are a fresh session picking up Phase B:
1. Read this file end-to-end.
2. Read `services/gateway/src/services/decision-contract/index.ts` to see the barrel that Phase A established.
3. Read `services/gateway/src/services/decision-contract/types.ts` so you know the `AssistantDecisionContext` shape Phase B will start feeding.
4. Allocate a new VTID via `POST https://gateway.vitanaland.com/api/v1/vtid/allocate` (one VTID per PR; do not reuse VTID-03111).
5. Follow the **Scope**, **Migration**, and **Acceptance** sections below.

This document is the **single source of truth for Phase B intent**. If something here disagrees with chat scrollback, this document wins.

---

## Why Phase B

The contextual-intelligence audit (May 2026) found **~140 hard-coded constants and ~30 hard-coded ladders** across the renderer, ranker, fusion engine, and voice/LiveKit layers. Every one of them is a *decision* baked into code where a multi-source fusion belongs.

Phase A landed the typed boundary (`AssistantDecisionContext` + invariants + renderer entry point). It changed no runtime behavior — by design. **Phase B is where the literals start moving out of code into versioned, tenant-aware, time-bounded DB rows.**

Without Phase B, a smarter fusion engine (Phase C) just becomes another place where decisions and rendering co-mingle. **Do B before C.**

---

## Scope

### In scope for Phase B
- New Supabase tables: `decision_policy`, `policy_render_block`.
- New service: `PolicyResolver` (sync-cached lookups; same shape as the existing `getPersonalityConfigSync` / `getAwarenessConfigSync` pattern).
- Seed all Phase-B-targeted constants into the new tables (seed values = current code constants → behavior is byte-identical at rollout).
- Vertical proof: migrate **one** consumer end-to-end to read from `PolicyResolver`. Recommended consumer: the temporal-bucket → greeting-policy block in `services/gateway/src/orb/live/instruction/live-system-instruction.ts` (lines ~72-312). It is the loudest leak in the audit and maps cleanly to `policy_render_block` rows.
- Tests covering: schema migration, resolver caching, byte-identical behavior at the vertical-proof consumer.

### Out of scope for Phase B (deferred to later phases)
- Ranker / fusion weights (`alpha_pillar`, `compass_boost`, `journey_mode` decay, dampeners, taste matrices). → Phase C.
- Voice timeouts, watchdog constants, the 5 voice-mapping tables, the all-Google fallback in `services/agents/orb-agent/src/orb_agent/providers.py:54-64`. → Phase D.
- Plumbing `conversationHistory` / `lastSessionInfo` / `recentTurnsBlock` / `memoryContext` / `profileBlock` into `orb-livekit.ts`. → Phase E.
- Migrating ALL Phase-B-targeted consumers in one PR. Each consumer is a separate PR after the vertical proof lands.

### Hard rules carried over from Phase A
- Every consumer reads its constants through `PolicyResolver`. No raw literal in a code path the resolver covers.
- The renderer reads only `AssistantDecisionContext`. Phase B does NOT alter the renderer's reads — it alters where the *values feeding the contract producers* come from.
- No Supabase client past the `decision-contract` boundary. D42 fusion and Context-Pack-Builder currently violate this; that fix is Phase B follow-up, not the keystone.

---

## Table schemas

### `decision_policy`

Versioned numeric/enum policy values. One row per `(policy_key, tenant_id, version)` triple.

```sql
CREATE TABLE decision_policy (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  policy_key      TEXT NOT NULL,           -- e.g. "session.recency_bucket.reconnect_seconds"
  tenant_id       UUID,                    -- NULL = global default; specific UUID overrides
  version         INTEGER NOT NULL,        -- monotonic per (policy_key, tenant_id)
  value_json      JSONB NOT NULL,          -- the value (number | string | object)
  effective_from  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  effective_until TIMESTAMPTZ,             -- NULL = open-ended
  source          TEXT NOT NULL DEFAULT 'seed',  -- 'seed' | 'admin_ui' | 'autopilot' | 'experiment'
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by      TEXT,
  UNIQUE (policy_key, tenant_id, version)
);
CREATE INDEX ON decision_policy (policy_key, tenant_id, effective_from DESC);
```

**Resolver query pattern:** for a given `(policy_key, tenant_id, now)`, pick the highest `version` row where `effective_from <= now AND (effective_until IS NULL OR effective_until > now)`. Tenant-specific row wins over `tenant_id IS NULL`.

### `policy_render_block`

Prompt fragments / rendered text — anything the model echoes or the renderer concatenates verbatim. Localized.

```sql
CREATE TABLE policy_render_block (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  block_key       TEXT NOT NULL,           -- e.g. "greeting.bucket.today"
  language        TEXT NOT NULL,           -- 'en' | 'de' | 'fr' | 'es' | 'ar' | 'zh' | 'ru' | 'sr'
  tenant_id       UUID,                    -- NULL = global default
  version         INTEGER NOT NULL,
  content         TEXT NOT NULL,           -- the rendered fragment, single-line or multi-line
  effective_from  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  effective_until TIMESTAMPTZ,
  source          TEXT NOT NULL DEFAULT 'seed',
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by      TEXT,
  UNIQUE (block_key, language, tenant_id, version)
);
CREATE INDEX ON policy_render_block (block_key, language, tenant_id, effective_from DESC);
```

**Resolver query pattern:** for a given `(block_key, language, tenant_id, now)`, identical resolution rules as `decision_policy`.

### RLS

Both tables: tenant isolation via standard RLS. Service-role bypasses (resolver runs as service). Read-only for normal app role.

---

## PolicyResolver service

Location: `services/gateway/src/services/decision-contract/policy-resolver.ts`.

API surface (sync where possible — cache-warmed at boot, like `getAwarenessConfigSync`):

```ts
export interface PolicyResolver {
  getValue<T>(key: string, opts?: { tenantId?: string; defaultValue?: T }): T;
  getRenderBlock(key: string, language: string, opts?: { tenantId?: string }): string;
  // Async warm-up + refresh:
  refresh(): Promise<void>;
}

export function getPolicyResolver(): PolicyResolver;  // singleton
export function configurePolicyResolverForTests(seed: Partial<...>): void;
```

Discipline:
- **Cache TTL: 15s** (matches `livekit-canary-config` pattern from the L2.1 work).
- **Never throws on resolution miss** — falls back to the row with `tenant_id IS NULL` first, then to a hard-coded constant of last resort (logged once at boot if used). A miss must NOT crash a voice session.
- **`getValue` returns the unwrapped JSONB value with TypeScript generics** so callers don't `JSON.parse` at every site.
- **Telemetry**: emit `decision_contract.policy.miss` OASIS event when fallback fires.

---

## Vertical proof: which consumer to migrate first

**Pick:** the temporal-bucket → greeting-policy block in `live-system-instruction.ts` (the `switch(bucket)` at lines ~226-312 from the audit). It pulls together both table types:

1. The **bucket thresholds** (`< 2 min` → `reconnect`, `< 15 min` → `recent`, etc., at lines ~72-97) → `decision_policy` rows like `session.recency_bucket.reconnect_seconds = 120`.
2. The **bucket-to-prompt** mapping (the entire switch body) → `policy_render_block` rows like `greeting.bucket.today` with 8 language variants.

Why this consumer first:
- Most visible decision leak in the audit (every "Hello [Name]!" complaint lives here).
- Maps cleanly to both tables — proves they work together.
- Already isolated in `live-system-instruction.ts` (Phase A characterized + locked its output).
- Behavior is byte-identical at rollout if the seed values match what's in code today.

Out of scope for this PR (do them as follow-ups, not in the vertical proof):
- Bucket thresholds in `services/gateway/src/services/guide/temporal-bucket.ts`.
- D32 time-of-day buckets in `services/gateway/src/services/d32-situational-awareness-engine.ts`.
- D33 readiness thresholds.

---

## Seed values for the vertical proof

From the audit. **Match these byte-for-byte** when writing the seed migration.

### `decision_policy` rows (global defaults, `tenant_id IS NULL`, `version = 1`)

| `policy_key` | `value_json` | Source of truth |
|---|---|---|
| `session.recency_bucket.reconnect_max_seconds` | `120` | `live-system-instruction.ts:72` |
| `session.recency_bucket.recent_max_minutes` | `15` | `live-system-instruction.ts:75` |
| `session.recency_bucket.same_day_max_hours` | `8` | `live-system-instruction.ts:78` |
| `session.recency_bucket.today_max_hours` | `24` | `live-system-instruction.ts:85` |
| `session.recency_bucket.week_max_days` | `7` | `live-system-instruction.ts:91` |

### `policy_render_block` rows

For each of the 8 buckets (`reconnect`, `recent`, `same_day`, `today`, `yesterday`, `week`, `long`, `first`), seed `greeting.bucket.<bucket>` for each of the 8 supported languages (`en`, `de`, `fr`, `es`, `ar`, `zh`, `ru`, `sr`).

**Seed content** = the exact lines currently pushed by `buildTemporalJourneyContextSection` at lines ~226-312 of `live-system-instruction.ts`. The switch statement IS the seed — copy verbatim.

Total: 8 buckets × 8 languages = 64 rows. If a language doesn't have a non-English variant today, seed it with the English content marked `notes: 'seeded from en; awaiting translation'`. Do NOT block on translation.

---

## Migration discipline

1. **One migration file per table** in `supabase/migrations/<YYYYMMDDHHMMSS>_vtid_NNNNN_<topic>.sql`.
2. **Seed file is separate** from schema migration — easier to re-run if seeds drift.
3. **Both tables must have RLS enabled before insert** (CLAUDE.md non-negotiable: "Always enforce tenant isolation").
4. **Document in `DATABASE_SCHEMA.md`** in the same PR (CLAUDE.md: "Always update DATABASE_SCHEMA.md when schema changes").

---

## Acceptance criteria

Before opening the Phase B PR:
- [ ] `decision_policy` + `policy_render_block` migrations apply cleanly on a fresh Supabase project.
- [ ] Seed migration inserts all `decision_policy` rows + all 64 `policy_render_block` rows.
- [ ] `PolicyResolver` warms cache at gateway boot; warm-up failure logs but does not crash.
- [ ] The vertical-proof consumer (`live-system-instruction.ts` greeting block) reads every value via `PolicyResolver` — `grep` shows zero remaining literal thresholds in that function.
- [ ] Snapshot tests at `test/orb/instruction/` show **byte-identical** prompt output before and after the migration (seed values match code constants).
- [ ] `npm run build` clean.
- [ ] `npx jest test/services/decision-contract test/orb/instruction` green.
- [ ] No new Supabase client created outside `services/gateway/src/services/decision-contract/`.

Before merging:
- [ ] Re-grep `origin/main` for the Phase B VTID to confirm no collision (per `feedback_vtid_collision_check_at_merge`).
- [ ] `DATABASE_SCHEMA.md` PR diff includes the two new tables.

Post-merge:
- [ ] EXEC-DEPLOY succeeds for the gateway.
- [ ] RUN-MIGRATION runs and reports rows-inserted counts matching the seed expectations (5 policy rows + 64 render-block rows for global defaults).
- [ ] `/alive` returns 200 JSON.
- [ ] One smoke run of `/orb/chat` returns a prompt whose temporal-bucket greeting block matches the relevant seeded text for the user's recency bucket + language.

---

## Suggested PR breakdown (each its own VTID)

Phase B is too large for one PR. Recommended slices:

1. **B.1** — Schema migrations only (`decision_policy` + `policy_render_block` + RLS). No code changes. DATABASE_SCHEMA.md update included.
2. **B.2** — Seed migration (the 5 `decision_policy` rows + 64 `policy_render_block` rows). Still no app code changes — the new tables now have data nothing reads.
3. **B.3** — `PolicyResolver` service + cache warm-up + tests. Boot-wired but no consumer reads it yet. Telemetry hooks in.
4. **B.4** — Vertical proof: migrate the `live-system-instruction.ts` greeting block to read via `PolicyResolver`. Snapshot tests prove byte-identical behavior.

After B.4 lands and is stable for at least one production session, follow-ups (each its own VTID, each own PR):
- B.5 — migrate `temporal-bucket.ts` cooling/absent thresholds.
- B.6 — migrate D32 time-of-day windows.
- B.7 — migrate D33 readiness thresholds.
- … etc., one consumer per PR.

---

## What to keep saying NO to

These are reflexes a fresh session might have when designing Phase B. Don't.

- **NO** burying the resolver inside a single route file. It is a service in `services/decision-contract/` and consumers import from there.
- **NO** synchronous DB read at request time. Cache is warmed at boot; refresh is async every 15s.
- **NO** "default" values inlined at call sites. The resolver owns fallbacks.
- **NO** stringly-typed policy keys scattered across the codebase. Export a `POLICY_KEYS` const from `services/decision-contract/policy-keys.ts` and require callers to use it.
- **NO** designing a UI in this phase. Admin editing UI is a separate later phase; the seeds + RLS-protected tables are enough for Phase B.
- **NO** adding new fields to `AssistantDecisionContext` in Phase B. The contract shape is Phase A's job; Phase B is where *values* come from, not where *new slices* go.

---

## References

- Phase A keystone PR: https://github.com/exafyltd/vitana-platform/pull/2273
- Phase A barrel: `services/gateway/src/services/decision-contract/index.ts`
- Audit source: project memory `project_decision_contract_phase_a_shipped.md` + the conversation that produced PR #2273
- Existing similar patterns to mimic: `getPersonalityConfigSync` (ai-personality-service), `getAwarenessConfigSync` (awareness-registry), `livekit-canary-config` (15s cache, never throws)
