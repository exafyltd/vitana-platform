# Phase C — RAG-only Memory Architecture (DESIGN ONLY)

**Status**: design-only (STOP-AND-ASK gate, orb-recovery §4.C). No code shipped.
**Decision (2026-06-01)**: under full-autonomous execution the coordinator produced this
design but did NOT change memory behavior — a wholesale memory-architecture swap is too
consequential to ship unsupervised. The acute overflow risk is already removed by Phase A
(`bootstrap-cap.ts`, #2403) + the R0 aggregate guard (#2492). Phase C is the permanent
structural fix, to be implemented behind a flag with human review of the eval.

## Problem it solves

Today the post-login `system_instruction` INLINES a memory dump (bootstrap pack: up to
~30 memory_facts + ~30 memory_items + knowledge hits + history). This is what grows with
the user and threatens the ~32 KB Vertex setup budget (the R0 root cause). Capping (Phase A
+ R0 guard) is a *safety net* — it trims useful memory under pressure. Phase C removes the
inlining entirely so size is bounded by construction.

## Target architecture

Replace "inline everything up front" with **retrieve-on-demand**:

1. **Minimal resident context** — the system_instruction carries only: identity (name,
   role, locale), the `UnifiedAwarenessContext` headline (journey/plan_phase/goal/index
   summary), and a 1–2 line "what you already know" digest. Fixed, small, size-stable.
2. **`search_memory` tool** (already exists in the ORB tool catalog) becomes the primary
   memory access path — the model calls it when a turn actually needs deep memory, getting
   relevance-ranked hits (Phase B ranker, #2411 + #2511) scoped to the query.
3. **No per-session memory dump** — `buildBootstrapContextPack` shrinks to the digest; the
   full pack is reachable only via the tool.

## Why it's safe + better

- **Size bounded by construction** — resident instruction no longer scales with accumulated
  memory; the R0 failure class cannot recur even without the cap.
- **Higher relevance** — the model fetches memory relevant to the actual turn instead of a
  recency/importance guess made before the user speaks.
- **Latency-neutral on turn 1** — turn 1 (greeting) rarely needs deep memory; the tool call
  only happens on turns that reference history.

## Rollout (flagged, eval-gated)

1. `FEATURE_RAG_ONLY_MEMORY` (default OFF). When OFF: today's inline pack (unchanged).
2. Shadow first: log resident-instruction bytes + how often `search_memory` would have been
   needed, on real traffic (reuse the Phase B `[memory.retrieval.shadow]` channel).
3. Canary `dragan1` (the heavy user) → measure: audio works, recall quality (does the model
   still "remember" via the tool?), turn-1 latency.
4. Human reviews the eval BEFORE the flag flips on (this is the STOP-AND-ASK gate honored).

## Files (when implemented — not in this PR)

- `services/gateway/src/services/context-pack-builder.ts` — digest-mode behind the flag.
- `services/gateway/src/routes/orb-live.ts` / `orb-livekit.ts` — resident context shrinks to digest.
- ORB tool catalog — ensure `search_memory` ranking + scoping is the Phase B ranker.
- Eval harness — recall@k on a fixed dragan1 question set, inline vs RAG-only.
