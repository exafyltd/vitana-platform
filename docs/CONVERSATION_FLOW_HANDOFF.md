# Conversation Flow — Build Handoff for the Command Hub "Conversation" section (v2)

**Audience:** the next session's agent, tasked with building a new **"Conversation"**
section in the Command Hub to **design, test, and maintain** Vitana's conversation
flow — **per tenant**.

**Status (2026-06-28):** the conversation-flow engine is built and live on the
gateway (Vertex ORB path) and hardened over several rounds (see §1). It is **global
and code-driven today**. This section's job is to give operators a UI to *see, tune,
test, and per-tenant customise* it. This doc is the source of truth for what to build.

> Placement requested by the operator: **sidebar order = … Assistant → `Conversation` → Voice …**
> Per-tenant: **each tenant designs its own flow on the same engine/tools, with its own
> overrides, logic and copy.**

---

## 0. TL;DR — what to build

1. A new **`Conversation`** Command Hub section (between Assistant and Voice) with
   sub-tabs: **Overview/Monitor**, **Registers & Recency**, **Next-Best-Action**,
   **Screen Completion**, **Tool Health**, **Simulator**, **Tenant Settings**.
2. A **gateway admin API** (`/api/v1/admin/conversation/*`) that (a) exposes the
   engine's current config + telemetry read models and (b) reads/writes **per-tenant
   overrides**.
3. A **per-tenant conversation config** store (mirror `tenant_settings`) + a
   **resolver** so the engine reads `global defaults ⊕ tenant overrides` instead of
   today's hardcoded constants.

The engine internals are §2–§5. The multi-tenant design is §6. The concrete build
recipe (exact files/lines/auth/CSP/build) is §7–§9.

---

## 1. Why this section exists — the recurring failure class

Every ORB UX bug the operator reported this week was the **same root pattern**, not
isolated bugs:

> A tool **succeeds (or has a graceful answer) but its spoken `text` is unusable** —
> a navigation announcement that no-ops in a text chat, raw JSON, an empty list, or a
> fabricated number — so the model has nothing real to say and **improvises a failure
> ("Das konnte ich leider nicht abschließen") or a hallucination**.

The live model (Vertex path) receives **only the tool result's `text`** (see
`dispatchOrbToolForVertex` → it sends `r.text`). So **every tool's `text` is a UX
surface.** Fixes shipped this session, all in this class:

| PR / VTID | Symptom | Fix |
|---|---|---|
| #2803 / VTID-03346 | index/nutrition plan "I cannot execute" for admin/staff roles | `toWritableRoleContext()` — session role → constraint-valid `role_context` |
| #2804 / VTID-03347 | guided journey offered "Lektion 1" while user on session 10 | anchor `narrate_guided_session` on `current_session` |
| #2807 / VTID-03348 | model lost journey progress mid-conversation | inject `buildGuidedJourneyStandingInstruction()` into the standing system instruction (Vertex + LiveKit) |
| #2810 / VTID-03350 | "+230 Punkte" fabricated on first diary entry of the day | only state an Index delta when a real same-day baseline exists |
| #2811 / VTID-03351 | "show my matches" → offer-then-fail | matches tool returns **speakable** content + anti-fake-fail guard; never raw JSON / nav-only |
| #2813 / VTID-03352 | "how to improve my Index" → couldn't complete; plan written opaquely | `get_index_improvement_suggestions` template fallback + speakable; `create_index_improvement_plan` **names** every scheduled activity |
| #2809 / VTID-03349 | (process) | **CI guard** `conversation-flow-change-needs-test` — no flow change merges without a flow test |

**The Conversation section is the operator's cockpit to catch this class proactively**
(see the Tool Health + Simulator tabs) instead of discovering it screenshot-by-screenshot.

**Speakable-tool contract (enforce in review + the new section's docs):** every ORB
tool's `text` must be (1) presentable content the model can speak, (2) never raw JSON,
(3) never a bare navigation announcement on a conversational surface, (4) carry an
explicit "Do NOT say you could not do it" guard on success/handled paths, (5) never
fabricate a number it didn't compute.

---

## 2. The engine — one decision from full context, always guiding

```
        ┌──────────── CONTEXT BUNDLE (gatherOverviewPayload, assembled once) ─────────────┐
        │ recency (describeTimeSince) · identity+memory · where-we-left-off · guided_journey │
        │ what's-new (Index move, matches, messages, reminders, calendar) · entry screen     │
        └───────────────────────────────────┬──────────────────────────────────────────────┘
                                             ▼
                               decideOpeningRegister()              ← recency FIRST
                                             ▼
   first_time · daily_briefing · continue · quick_resume · same_day      ← the REGISTER
                                             ▼
                               selectNextBestAction()                ← the always-guiding step
                                             ▼
                       one composed first-turn directive → the LLM speaks it
```

Two invariants: **(1) recency is the primary gate** (a return after 1 min is never
"Guten Morgen"); **(2) Vitana always closes on a concrete next step** spanning the two
north stars — **community engagement** and **health improvement**.

### Registers (`decideOpeningRegister`)
| Register | Trigger | Greeting |
|---|---|---|
| `first_time` | never onboarded | ✅ welcome |
| `daily_briefing` | `briefingDue` (first session of a real day; durable flag `user_journey.last_full_briefing_date`) | ✅ time-of-day |
| `continue` | bucket `reconnect` (<2 min) | ❌ pick the thread back up |
| `quick_resume` | bucket `recent` (<15 min) | ❌ micro-ack |
| `same_day` | bucket `same_day`/`today` | ⚠️ light |

Recency buckets: `services/gateway/src/services/guide/temporal-bucket.ts` → `describeTimeSince`
(8 buckets reconnect/recent/same_day/today/yesterday/week/long/first).

### Next-Best-Action (`next-best-action.ts`) — "always guiding"
Pure function over `OverviewPayload`. Ranks every **grounded** action (gated on real
data; never bluffs) by **band = value × timeliness**; rotation via durable
`user_journey.recent_nbas` (cooldown 3) so it never repeats. Bands 100→26 across
time-sensitive → continuity → health momentum → community growth → setup. North-star
mapping + `CAPABILITY_BY_KEY` (each action → the real ORB tool that executes it).

### Screen awareness & completion (`screen-surface.ts`)
`surfaceForRoute(route)` → surface; `screenCompletionFor(surface)` → completion action
(band 115, above redirects) + `redirect_key` to suppress. The goal is to **finish the
action on the screen the user is on**, never redirect to a screen they're already on.

### Capability-gating
The opener guides → user accepts → it must **execute** via the mapped tool
(`CAPABILITY_BY_KEY`, verified against `ORB_TOOL_REGISTRY`); if no tool, **guide
step-by-step**, never over-promise.

---

## 3. Asset inventory (confirmed paths + key exports)

| Asset | Path | Key exports |
|---|---|---|
| NBA engine | `services/gateway/src/services/conversation/next-best-action.ts` | `rankNextBestActions(p,ctx)` (L119); `selectNextBestAction(p,ctx)` (L228); `CAPABILITY_BY_KEY` (L75); `capabilityForNba(key)` (L95); type `NbaKey` (L30) |
| Opening register | `services/gateway/src/services/conversation/decide-opening.ts` | `decideOpeningRegister(input)` (L53); `buildResumeDirective(input)` (L102); type `OpeningRegister` (L35) |
| Screen surface | `services/gateway/src/services/conversation/screen-surface.ts` | `surfaceForRoute(route)` (L39); `screenCompletionFor(surface)` (L70) |
| Index coach text | `services/gateway/src/services/orb-index-coach-text.ts` | `buildIndexSuggestionsText(pillar,items)` (L18); `buildIndexPlanText(pillar,days,scheduled)` (L45) |
| Context bundle | `services/gateway/src/services/assistant-continuation/providers/new-day-overview-payload.ts` | `gatherOverviewPayload(args)` (L269); `fetchGuidedJourney(sb,userId,lang)` (L677); `buildGuidedJourneyStandingInstruction(gj)` (L716); iface `OverviewPayload` (L81) |
| Daily briefing render | `…/providers/new-day-overview-prompt.ts` | `buildNewDayOverviewBlock` |
| Acceptance gate | `services/gateway/src/services/assistant-continuation/acceptance-gate.ts` | `detectAcceptance(text)` (L87); `maybeBindAcceptance(input,deps)` (L136); `makeSupabaseAcceptanceDeps(sb)` (L108) — **binds wake-brief offers only today** |
| Provider registry | `services/gateway/src/services/assistant-continuation/provider-registry.ts` | provider registry (single file, not a dir) |
| Guided journey state | `services/gateway/src/services/guided-journey/guided-journey-state.ts` | `getJourneyState(client,userId)` (L84) → `{ currentSession, completedTopicIds, … }` |
| Recency | `services/gateway/src/services/guide/temporal-bucket.ts` | `describeTimeSince` |
| Live system instruction | `services/gateway/src/orb/live/instruction/live-system-instruction.ts` | `buildLiveSystemInstruction(lang,voiceStyle,bootstrapContext?,…,surface?)` (L376) — 4 call sites: orb-livekit.ts ×2, orb-live.ts ×1, voice-lab ×1 |
| Greeting prefetch + bootstrap context | `services/gateway/src/orb/live/session/live-session-controller.ts` | greeting-facts prefetch; `finalContext` assembly (~L860–896) — where the standing journey block is appended |
| Integration (Vertex) | `services/gateway/src/routes/orb-live.ts` | `sendGreetingPromptToLiveAPI`; `executeLiveApiTool`; `emitDiag` (L12304) |
| Shared ORB tools | `services/gateway/src/services/orb-tools-shared.ts` | `ORB_TOOL_REGISTRY`, `dispatchOrbTool`, all the action tools |
| Self-check harness | `services/gateway/src/routes/orb-tools-selfcheck.ts` | `POST /api/v1/admin/orb-tools/selfcheck {user_id,tools?}` (admin-gated) |
| CI guard | `scripts/ci/impact-rules/conversation-flow-change-needs-test.mjs` | blocker rule (see §1); `FLOW_SOURCE_RE` now also covers `routes/orb-live.ts` + `routes/orb-livekit.ts` (Step 1a) |
| **Greeting-decision seam (Step 1a)** | `services/gateway/src/services/conversation/compute-greeting-decision.ts` | `computeGreetingDecision(ctx)` — PURE transcription of the Vertex greeting ladder (9 `wake_opener` rungs + legacy default); `GreetingDecisionContext`, `GreetingDecision`, `safeFastApplies`, `shouldAttemptNewdayOverview`, `shouldAttemptResumeOverview` |
| **Transport-parity scanner (Step 1a)** | `scripts/ci/impact-rules/transport-flow-parity.mjs` | `warning` today; flags a transport file that still owns inline register/recency/`wake_opener` logic; flips to `blocker` at end of 1c |
| **Memory orchestrator (#2830/#2831)** | `services/gateway/src/services/memory-orchestrator.ts` | `buildAssistantMemoryContext(input)` (L479) → `AssistantMemoryContext`; `formatMemoryContextForPrompt` (L427); `assertMemoryContextInjected` (L747, the mandatory-injection guard); `detectMemoryBypass` (L795); `emitMemoryTurnTelemetry` (L871); sentinels `=== USER MEMORY CONTEXT ===`. Admin route `routes/admin-memory-orchestrator.ts`. |
| **Social context pack (#2832/#2833)** | `services/gateway/src/services/social-memory/*` | `buildSocialContextPack` (social-context-builder L56) → `SocialContextPack`; `buildAssistantSocialContext` (social-memory-service L50) → `AssistantSocialContextResult`; `formatSocialContextForPrompt(pack)` (social-memory-prompts L104) → the `<social_context>` instruction block; `detectSocialIntent` (L75); rankers `rankInterestingPosts`/`rankInterestingEvents`. Route `routes/memory-social.ts`; ORB tool `get_social_context` (dispatched in `orb-live.ts` `executeLiveApiToolInner`). |
| Architecture | `docs/CONVERSATION_FLOW_ARCHITECTURE.md` | "one brain, many mouths" |

### 3.1 New context layers — memory orchestrator + social context pack (added after v2)

Two subsystems landed **after** this doc's v2 and after the roadmap-v3 Step-1a seam.
They enrich the **per-turn context and the tool surface**, and are wired into
`buildBootstrapContextPack` + `executeLiveApiToolInner` + the standing system
instruction — **not** into the greeting-decision ladder. `computeGreetingDecision`
therefore remains faithful; but the SINGLE BRAIN (roadmap Step 1b) and this
Command-Hub section (Step 4) must treat them as first-class:

- **Memory orchestrator** — a MANDATORY memory step before every assistant answer.
  It assembles `AssistantMemoryContext` (active goals, preferences, do-not-repeat)
  and injects it between the `=== USER MEMORY CONTEXT ===` sentinels;
  `assertMemoryContextInjected` fails loudly if a turn would answer without it.
  → **Step 1b:** `ConversationContext` must carry the resolved memory context (or a
    handle to it) so the brain's decisions are memory-aware and the injection guard
    is expressible as an invariant. → **Step 4 (Hub):** the **Monitor** shows the
    memory-injected/bypass telemetry (`MEMORY_ORCHESTRATOR_EVENT_TYPES`), and the
    **Simulator** must render the memory block it assembled for the dry-run user.
- **Social context pack** — `buildSocialContextPack` / `buildAssistantSocialContext`
  produce a ranked view of the user's people/matches/posts/events; it reaches the
  model two ways: (a) the `<social_context>` block in the standing instruction
  (`formatSocialContextForPrompt`), and (b) the on-demand `get_social_context` tool.
  `detectSocialIntent` decides when a turn is socially-flavoured.
  → **Step 1b:** the offer/next-turn contract and NBA ranking should be able to read
    social signals (matches/messages already are in `OverviewPayload`; the richer
    social pack is the superset). → **Step 4 (Hub):** **Tool Health** lists
    `get_social_context` and its failure feed; the **Simulator** shows the assembled
    social pack; a future **Social** sub-view can surface the ranker inputs.

**Net:** Step 1a (greeting seam) is unaffected and correct. The reconcile above is a
scope update so 1b + the Hub design against the CURRENT flow, not the pre-#2830 one.

---

## 4. Observability the section must surface (already emitting)

All to `oasis_events`. Read these for the Monitor + Tool Health tabs:

- **Greeting decisions** — topic `orb.live.diag`, `metadata.stage='greeting_sent'`:
  `wake_opener`, `register`, `bucket`, `nba`, `nba_domain`, `briefing_date`,
  `overview_signals`, `current_route`.
- **Tool failures** — topic `orb.live.diag`, `metadata.stage='tool_failed'`:
  `tool`, `soft` (true = handler returned ok:false/reason), `ms`, `detail` (raw error).
  Fires for HARD (`success===false`) and SOFT failures. (`emitDiag` in orb-live.ts L2390.)
- **Self-check runs** — topic `orb.tools.selfcheck`: per-tool `ok`, `soft_fail`, `ms`,
  `detail`, `user_id`.

Example (recent tool failures):
```sql
select created_at, metadata->>'tool' as tool, metadata->>'soft' as soft, metadata->>'detail' as detail
from oasis_events
where topic='orb.live.diag' and metadata->>'stage'='tool_failed'
order by created_at desc limit 50;
```

---

## 5. The CI guard (do not regress)

`conversation-flow-change-needs-test` (registry.mjs + seed migration) is a **blocker**:
any change under `conversation/`, `assistant-continuation/`, `guide/`,
`guided-journey/`, `orb/live/instruction/`, `live-session-controller.ts`, or
`orb-tools-shared.ts` **must** ship with a matching test under `services/gateway/test/`
(broad keyword set incl. conversation/narrate/guided/journey/index/match/diary/tool).
Escape hatch: `flow-test-exempt: <reason>` in a changed flow file. **The Conversation
section's backend changes will hit this — write the test in the same PR.**

---

## 6. MULTI-TENANT architecture (the new requirement) — DESIGN, build this

**Today the flow engine is GLOBAL and hardcoded; only the *data* it reads is
tenant-scoped.** Specifically:
- NBA bands/rotation, register thresholds, screen-completion map, the v3 flow
  priorities (`services/gateway/src/services/guide/conversation-flow-v3.ts`) and the
  speakable-text builders are **constants in code** — identical for every tenant.
- Feature flags via `isFeatureLive` (`services/gateway/src/services/feature-flags.ts`)
  are **global per-process env vars**, NOT per-tenant.
- The context bundle, journey, matches, diary etc. ARE tenant-scoped (queries filter
  `.eq('tenant_id', …)`; identity carries `tenant_id` from JWT `app_metadata.active_tenant_id`).

So **per-tenant conversation design is greenfield.** The clean way to add it without a
rewrite:

### 6.1 Storage — mirror `tenant_settings`, do NOT mirror the global impact-rules table
`tenant_settings` (`supabase/migrations/20260412300000_tenant_settings.sql`) is the
canonical per-tenant pattern: `tenant_id UUID PRIMARY KEY REFERENCES tenants(id)` +
JSONB buckets + RLS (`service_role_all` + `tenant_read` keyed on
`raw_app_meta_data->>'active_tenant_id'`). **(`dev_autopilot_impact_rules` is the WRONG
mirror — it is a *global* registry with PK `rule TEXT`, no tenant_id.)**

Create `tenant_conversation_config`:
```sql
CREATE TABLE public.tenant_conversation_config (
  tenant_id   UUID PRIMARY KEY REFERENCES public.tenants(id) ON DELETE CASCADE,
  enabled     BOOLEAN NOT NULL DEFAULT TRUE,        -- master switch (else pure global defaults)
  registers   JSONB   NOT NULL DEFAULT '{}'::jsonb, -- recency thresholds, greeting on/off per register
  nba         JSONB   NOT NULL DEFAULT '{}'::jsonb, -- band overrides, enable/disable actions, rotation pool, cooldown
  screen      JSONB   NOT NULL DEFAULT '{}'::jsonb, -- per-surface completion offers
  copy        JSONB   NOT NULL DEFAULT '{}'::jsonb, -- tenant brand-voice overrides for tool text / directives
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by  TEXT
);
-- + ENABLE RLS; service_role_all + tenant_read policy copied verbatim from tenant_settings.
```
Keep each bucket a **sparse override** — absent keys fall back to the global default.

### 6.2 Resolver — global defaults ⊕ tenant overrides (the keystone)
Add `services/gateway/src/services/conversation/config-resolver.ts`:
```ts
export interface ConversationConfig { registers: …; nba: …; screen: …; copy: …; }
export const GLOBAL_DEFAULTS: ConversationConfig = /* the current hardcoded constants, extracted */;
export async function resolveConversationConfig(sb, tenantId: string|null): Promise<ConversationConfig>
// reads tenant_conversation_config for tenantId, deep-merges over GLOBAL_DEFAULTS (5-min cache).
```
Then **thread the resolved config** into the pure engine functions as a parameter:
`decideOpeningRegister(input, cfg.registers)`, `rankNextBestActions(p, ctx, cfg.nba)`,
`screenCompletionFor(surface, cfg.screen)`. They stay pure + unit-testable; the only
new I/O is the resolver call at the integration points (orb-live.ts greeting path,
live-session-controller bootstrap) where `tenant_id` is already in scope. **Default
behaviour is unchanged** when a tenant has no row (resolver returns `GLOBAL_DEFAULTS`).

### 6.3 Tenant scoping in the hub — NOTE A GAP
The Command Hub has **no tenant switcher today**; it operates on the signed-in admin's
single `state.meContext.tenant_id` (sent as `X-Vitana-Tenant`). The Conversation
section needs to **design for an arbitrary tenant**, so it must introduce a
**tenant selector** (dropdown populated from the Admin→Tenants list) that passes a
`tenant_id`/`tenant_slug` param to the new endpoints. This is a **new pattern** — there
is one precedent for a tenant-param call (`/api/v1/admin/ai-assistants/policies/:tenantSlug`)
to mirror, but no global switcher to copy. Gate every write with `requireExafyAdmin`
AND verify the target tenant is allowed (see `require-tenant-admin.ts` for the
cross-tenant 403 pattern).

---

## 7. Command Hub build recipe (exact, verified)

**Editable source ONLY:** `services/gateway/src/frontend/command-hub/`. `dist/…` is
build output (`npm run build` → `tsc && cp -r src/frontend/command-hub/* dist/…`). Never
hand-edit dist. **`navigation-config.js` is stale & auto-generated — do NOT edit it;
the real nav is in `app.js`.**

Four edits in `services/gateway/src/frontend/command-hub/app.js`:

1. **Nav entry** — insert a section object **between the Assistant object (ends ~L2751)
   and the Voice object (`// VTID-02856` ~L2752)** inside `NAVIGATION_CONFIG`:
   ```js
   {
     "section": "conversation",
     "basePath": "/command-hub/conversation/",
     "tabs": [
       { "key": "monitor",   "label": "Monitor",          "path": "/command-hub/conversation/monitor/" },
       { "key": "registers", "label": "Registers",        "path": "/command-hub/conversation/registers/" },
       { "key": "nba",       "label": "Next-Best-Action",  "path": "/command-hub/conversation/nba/" },
       { "key": "screens",   "label": "Screen Completion", "path": "/command-hub/conversation/screens/" },
       { "key": "tools",     "label": "Tool Health",       "path": "/command-hub/conversation/tools/" },
       { "key": "simulator", "label": "Simulator",         "path": "/command-hub/conversation/simulator/" },
       { "key": "tenant",    "label": "Tenant Settings",   "path": "/command-hub/conversation/tenant/" }
     ]
   },
   ```
2. **`SECTION_LABELS`** (~L2968): add `'conversation': 'Conversation',` between
   `'assistant'` and `'voice'`.
3. **`renderModuleContent(moduleKey, tab)`** (~L6968; Assistant block ~L7002–7016):
   add `else if (moduleKey === 'conversation' && tab === '…') { container.appendChild(renderConversation<Tab>View()); }`
   branches **after the Assistant block, before Voice**.
4. **View builders + state + fetch:** add `renderConversation<Tab>View()` fns (DOM-imperative,
   mirror `renderAssistantOverviewView()` at L51524), a `state.conversation` slice
   (mirror `state.assistantOverview` at L3943), and `fetchConversation*()` fns that call
   the new endpoints with `buildContextHeaders(...)` (L635 — attaches Bearer token +
   `X-Vitana-Tenant`; for the tenant selector, pass the chosen tenant explicitly).

Deep-links work automatically once the nav entry exists (`getRouteFromPath` L10619).

**CSP** (set in `routes/command-hub.ts` L71): `script-src 'self'` → **no inline JS**
(external/bundled only); inline `style=`/`el.style.cssText` is allowed. New API hosts
must be added to `connect-src` (currently self + livekit) — your endpoints are
same-origin so no change needed.

**Cache-bust:** bump `?v=` on the `app.js`/`styles.css` links in
`src/frontend/command-hub/index.html` (L25/L33).

**Deploy:** merge to `main` → STAGING only (`gateway-staging`, `preview-gateway.vitanaland.com`);
prod via PUBLISH button. (Per CLAUDE.md §16 staging-first.)

---

## 8. The Conversation section — sub-tabs (build spec)

| Tab | Shows | Reads / Writes |
|---|---|---|
| **Monitor** | Live decision feed: recent opens with register + recency bucket + chosen NBA + present signals + `current_route`. Register & NBA distributions (community vs health balance). Flag anomalies (too many bare `safe_fast_newday` fallbacks). | `oasis_events` greeting_sent (§4) |
| **Registers** | The 5 registers + recency thresholds (reconnect <2m, recent <15m, same_day <8h…), greeting on/off per register. Editable per tenant. | resolver defaults + `tenant_conversation_config.registers` |
| **Next-Best-Action** | The band table, the community-growth rotation pool, cooldown; enable/disable actions; `CAPABILITY_BY_KEY` (action → tool). Editable per tenant. | defaults + `…nba` |
| **Screen Completion** | The per-surface completion map (§2). Editable per tenant. | defaults + `…screen` |
| **Tool Health** | The `tool_failed` feed (tool, soft/hard, detail) + a **"Run self-check for user_id"** button calling `POST /api/v1/admin/orb-tools/selfcheck`. This is the proactive catch for the §1 failure class. | `oasis_events` tool_failed + selfcheck endpoint |
| **Simulator** | Given a `user_id` (+ optional tenant), dry-run the decision: show assembled bundle, chosen register, ranked NBAs, the composed directive — **without speaking**. | new preview endpoint (§9) |
| **Tenant Settings** | Tenant selector + master `enabled` switch + brand-voice `copy` overrides; diff vs global defaults. | `tenant_conversation_config` |

---

## 9. Gateway endpoints to add (new `src/routes/conversation-hub.ts`, admin-gated)

Mount at `/api/v1/admin/conversation`, `router.use(requireAuth, requireExafyAdmin)`.
This route file will trip the CI flow-test guard → ship a test in the same PR.

- `GET  /config?tenant_id=…` → resolved config (defaults ⊕ tenant overrides) + the raw
  override row, for the editor tabs.
- `PUT  /config?tenant_id=…` → upsert `tenant_conversation_config` (validate with Zod;
  record `updated_by`).
- `GET  /preview?user_id=…&tenant_id=…` → `{ bundle, register, nba, ranked_nbas, directive }`
  by calling `gatherOverviewPayload` + `resolveConversationConfig` + `decideOpeningRegister`
  + `rankNextBestActions` (read-only; never speaks). Powers the Simulator.
- `GET  /decisions?limit=…&tenant_id=…` → read model over `oasis_events` greeting_sent.
- `GET  /tool-failures?limit=…` → read model over `oasis_events` tool_failed.
- `POST /selfcheck` → proxy/call the existing `orb-tools/selfcheck` (or just have the UI
  call that endpoint directly).
- `GET  /tenants` → list tenants for the selector (or reuse the Admin→Tenants source).

---

## 10. Open follow-ups (the real "endless loop" enders — carry these in)

These two close the failure **class**, not instances:

- [ ] **Confirm-before-consequential-write.** Today `create_index_improvement_plan`
  writes 6 calendar events then describes them; the user wanted to approve the concrete
  plan first ("du musst doch erst mit mir…"). Add a propose→confirm step for
  consequential writes (present the plan, gate the write on acceptance). Ties into the
  acceptance gate below.
- [ ] **Bind every mid-conversation offer.** `acceptance-gate.ts` only binds offers that
  wrote a `pending_cta` (wake-brief today). When Vitana improvises an offer mid-chat and
  the user says "Ja", there is no binding → the model free-interprets and can fail. Make
  every offer Vitana makes write a `pending_cta` so acceptance always executes the exact
  offered action. **This is the structural end of the offer-then-fail class.**

Engine follow-ups:
- [ ] Build a real `update_profile_field` tool so `complete_profile` graduates from guide-only.
- [ ] Converge transports: LiveKit / 3rd provider should call the SAME
  `decideOpeningRegister` + NBA (Vertex wired first).
- [ ] Move `gatherOverviewPayload` into the greeting-facts prefetch so reopen is instant.

---

## 11. Change log

| Date | Change |
|---|---|
| 2026-06-27 | v1: unified opening decision (registers, recency-first) + NBA engine on the Vertex SAFE-FAST path; durable once-per-day briefing flag; initial handoff. |
| 2026-06-28 | v2: added the speakable-tool failure-class framing (§1) + the 6 fixes shipped (#2803/2804/2807/2810/2811/2813), tool-failure telemetry + self-check + the `conversation-flow-change-needs-test` CI guard (#2809), refreshed asset inventory with exact lines, the **multi-tenant architecture** (`tenant_conversation_config` + resolver, §6), and the **concrete Command Hub build recipe** (exact app.js edits, auth/CSP/build, endpoints, sub-tabs, §7–§9). |
