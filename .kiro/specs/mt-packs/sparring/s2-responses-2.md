# Responses to sparring round 2 (session 2, `eb308b4e-c1f4-442f-8624-0b92becdecee`)

```json
[
  {
    "finding_id": "R2-F1",
    "disposition": "accepted",
    "rationale": "Verified: computeGreetingDecision (compute-greeting-decision.ts:699) is pure with impurity injected by the caller (header :21-29); the first-time welcome directive is built inline at :1232-1237 with the literal 'Welcome them warmly to Maxina' at :1233; GreetingDecisionContext (:238) has firstName (:266) but no tenant/brand field. The only places a context is built are the three typed literals in orb-live.ts (_baseCtxSF :10917, _baseCtxSync :11297, _ctxNS :11584); decide-conversation-flow.ts:144 forwards one. Fix (option a): (1) GreetingDecisionContext gains an OPTIONAL communityName?: string | null (optional so existing test fixtures still type-check); (2) the :1233 literal becomes ${ctx.communityName || 'Maxina'}; (3) handleLiveSessionStart sets session.packFacts = getEffectiveConfigSync('voice_live', tenantId).pack_facts ?? MAXINA_PACK_FACTS after the prewarm (PackFacts typed, Maxina default in code); (4) each of the three orb-live.ts literals gains one line communityName: session.packFacts.communityName. The orb-live.ts diff list is extended with item (f), +3 lines, net hand-written <= 8 lines plus the verbatim move, inside the §8 cap of 20. Updated plan.md persona-pack bullet + Tests + Out of scope, tasks.md P3/P3b, lane body + log.",
    "deferred_to": null
  },
  {
    "finding_id": "R2-F2",
    "disposition": "accepted",
    "rationale": "Verified :1233 is the literal and compute-greeting-decision.ts is already in the persona-pack paths (added in s2 round 1). The plan and tasks P3b now name the exact edit at :1233 (the literal 'Maxina' replaced by ${ctx.communityName || 'Maxina'}) and what the golden pins: with communityName absent and with 'Maxina' the directive equals today's exact string (byte-identical), with a fixture tenant's name it carries that name and nothing else changes. The name stays a FACT inside an English INTENT (rule 41), never a finished sentence. Updated plan.md persona-pack F4 + Tests, tasks.md P3b/P5.",
    "deferred_to": null
  }
]
```
