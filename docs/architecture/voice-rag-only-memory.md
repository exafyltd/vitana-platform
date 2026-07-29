# Voice RAG-Only Memory — Design Doc (Phase C)

**Status:** DRAFT — awaiting founder approval (STOP-AND-ASK gate).
**VTID:** allocate at approval time (`BOOTSTRAP-orb-rag-only-memory` placeholder).
**Author:** Claude (autonomous harness), Phase C of the ORB Recovery + Memory Resilience plan.
**Related:** Phase A (bootstrap cap, PR #2403), Phase B (relevance ranking, PR #2405), Phase D (budget observability, PR #2404).

> ⛔ **This document is the deliverable. No Phase C code is written until a founder approves this direction.** Phases A + B + D buy the time this phase spends in review.

---

## 1. Problem

The post-login Vertex `system_instruction` is assembled by concatenating the user's
accumulated memory (`memory_items`, `memory_facts`, conversation history, life-compass,
Vitana index, autopilot pending, activity timeline) into one string. As a user
accumulates memory over months, that string grows without bound. When it exceeds the
~32 KB Vertex Live API setup budget, Vertex **silently** fails setup → no TTS frames →
"Vitana won't talk."

- **Phase A** caps the bootstrap at 12 KB (truncate-from-bottom) — guarantees *something*
  fits, but drops content.
- **Phase B** ranks what stays — the *most useful* 12 KB survives.
- **Phase C (this doc)** removes the problem class entirely: stop concatenating memory
  into `system_instruction`; fetch it **on demand** via a `search_memory(query)` tool.
  Setup instruction becomes **constant size** regardless of user weight.

## 2. Current state

```
session start
   │
   ▼
buildLiveSystemInstruction(lang, voiceStyle, bootstrapContext, …)
   │   bootstrapContext = vitana-brain render of:
   │     • USER CONTEXT PROFILE (memory_items, top-N)
   │     • FACTS (memory_facts)
   │     • ACTIVITY_14D / RECENT / CONTENT_PLAYED
   │     • HEALTH (Vitana index, pillars)
   │     • life-compass goal, journey day
   │     • autopilot pending CTA
   │   → all inlined into the ~32 KB system_instruction
   ▼
Vertex Live setup  ──(if > ~32 KB)──►  silent failure, no audio
```

`search_memory` already exists as a tool but is a *secondary* path; the *primary* path
is concatenation.

## 3. Target state

```
session start
   │
   ▼
buildLiveSystemInstruction(…)   ← CONSTANT size: identity, role, tone, tool catalog,
   │                              a SHORT "recent activity" digest (≤1 KB), and an
   │                              instruction: "call search_memory(query) to recall
   │                              anything about the user."
   ▼
Vertex Live setup  ──►  always within budget, any user weight
   │
   ▼
turn: user asks "do you remember my fiancée's name?"
   │
   ▼
model calls search_memory("fiancée name")  ──►  gateway returns top-K w/ provenance
   │
   ▼
model answers from tool result
```

## 4. Memory sources — decision table

| Source | Today | Phase C decision | Rationale |
|---|---|---|---|
| `memory_items` (bulk) | inlined top-N | **on-demand** via `search_memory` | the dominant size driver |
| `memory_facts` (semantic keys: user_name, birthday, fiancée_name) | inlined | **stays in setup** (tiny, high-value, always-needed for natural greeting) | bounded count, identity-critical |
| conversation_history | inlined (4 KB cap) | **stays** (already capped) | reconnect continuity |
| life_compass goal | inlined | **stays** (single short line) | greeting personalization |
| Vitana index / pillars | inlined (large) | **on-demand** via `search_memory` mode=`health` OR a short 1-line digest in setup | big; only needed when health comes up |
| activity timeline (ACTIVITY_14D/RECENT/CONTENT_PLAYED) | inlined (large) | **short digest in setup** (≤1 KB) + **on-demand** for detail | "what did I play" needs detail; greeting needs a hint |
| autopilot pending CTA | inlined | **stays** (Phase ORB-5 shared state, short) | needed for "yes" handling at turn 1 |

**Net:** setup keeps only bounded, identity/continuity-critical, short items. Everything
unbounded moves to `search_memory`.

## 5. Tool surface changes

`search_memory(query: string, mode?: 'general'|'health'|'activity'|'relationships', top_k?: number)`

- New optional `mode` to route to the right index (memory_items vs health vs timeline vs relationship graph).
- Richer return: `{ id, content, provenance: {source, confidence}, occurred_at, score }[]` so the model can attribute ("you told me on May 2…").
- Reuses Phase B `rankMemory` for the top-K ordering (semantic similarity now *does* have an intent embedding — the query — so the 0.2 similarity term activates).

## 6. Latency budget

- Concatenation today: 0 extra round-trips at turn time (everything pre-loaded).
- RAG: +1 tool round-trip **only on turns that need recall** (~100–300 ms: embedding + pgvector query + return). Greeting + identity turns need **no** extra call (facts + digest in setup).
- Mitigation: warm the embedding for the first likely query; cache per-session; keep the short activity digest in setup so the most common "what have I been up to" gets a good-enough answer with zero round-trips, and `search_memory` only fires for specifics.

## 7. Migration plan

1. Feature flag `MEMORY_ON_DEMAND_RAG` (already exists in `feature-flags.ts`, default false).
2. `buildLiveSystemInstruction` skips the bulk-memory concatenation block when the flag is on (facts + digest + life-compass + CTA still included).
3. `search_memory` gets `mode` + richer return; LiveKit Python agent gets the parallel tool (see `docs/patches/orb-agent/`).
4. Shadow: log instruction size with/without the bulk block for 48h (reuse Phase D budget telemetry).
5. Canary: flag on for dragan1 (heaviest) → verify instruction size flat, audio plays, "do you remember…" triggers `search_memory`.
6. Expand by cohort (heaviest users first — they get the biggest win).

## 8. Risks + mitigations

| Risk | Mitigation |
|---|---|
| Greeting feels less rich (model no longer "just knows" everything) | Keep facts + short activity digest + life-compass in setup; only *bulk/detail* moves on-demand |
| Extra latency on recall turns | Only recall turns pay it; cache; warm embedding; digest covers the common case |
| Model forgets to call `search_memory` | Strong setup instruction + few-shot; eval suite asserts the call fires on "do you remember" |
| Vertex ↔ LiveKit drift | Parallel tool impl + shared eval; parity asserted per the plan |
| Provenance/attribution regressions | Richer return shape carries source+confidence; eval checks attribution |

## 9. Acceptance (post-approval)

- Instruction size **flat** vs user weight (heavy-user staging fixture: dragan1 after 6 months).
- Audio plays for the heaviest synthetic user.
- "Do you remember…" queries trigger `search_memory` (asserted in E2E on **both** providers).
- No greeting-quality regression in the eval suite.

## 10. Founder ask

**Approve this direction, or redirect.** Specifically:
1. Is the "facts + short digest stay in setup, bulk/detail go on-demand" split acceptable for greeting richness?
2. Is +100–300 ms on recall-only turns acceptable?
3. Any source in §4 you want to keep inlined regardless?

Once approved, Phase C implementation will be spec'd in §4.C.3 of the execution plan and built behind `MEMORY_ON_DEMAND_RAG` with the migration in §7.
