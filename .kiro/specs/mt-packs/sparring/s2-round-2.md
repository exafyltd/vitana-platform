# Sparring round 2 — in_progress

Session: `eb308b4e-c1f4-442f-8624-0b92becdecee` · plan hash `45ed832607f4673ed5e37771dc1bd6cf294237bc90f2ad3d3aee2229ab6ee873`

## Summary

Round 2. The four prior findings were all accepted and the revision substantially corrects the premises: getPersonalityConfigSync is confirmed at ai-personality-service.ts:460 (configCache :351, CACHE_TTL_MS :344, isCacheValid :353), the wholesale base_identity overwrite at :688 is confirmed, getTenantMeta/getDefaultTenantId and the loadTenantFlags byId map are confirmed (no existing bySlug lookup), LiveSessionStartRequest (types.ts:42) has no tenant field, and the FIXED/TENANT map + dead-code evidence for tenure_opening_shapes/last_interaction_acknowledgements is plausible. One accepted finding (R1-F2/F4's FACT-based intent) is NOT actually addressed by the revision: the first-time welcome intent at compute-greeting-decision.ts:1233 still hardcodes the literal "Maxina", and the plan gives no mechanism to thread a per-tenant community-name FACT into the pure, sync computeGreetingDecision (its GreetingDecisionContext has no tenant/brand field). This is re-raised as a new blocker-level gap plus a related major finding on the FIXED default for the welcome intent.

## Findings

### R2-F1 [blocker]

The plan's F4 says the first-time welcome intent 'takes the community name as a FACT from the resolved pack (default Maxina → byte-identical)'. This is not wired anywhere in the diff the plan enumerates. computeGreetingDecision builds the welcome directive INLINE at :1232-1237 with the hardcoded English literal 'Welcome them warmly to Maxina' inside buildOpeningIntentDirective, and GreetingDecisionContext (the pure function's entire input, lines 238-417) contains NO communityName/tenantId/brand field. computeGreetingDecision is documented as PURE with all impurity injected by the caller (file header :21-29); it has no access to a session, tenant, or pack. The plan's orb-live.ts diff (a)-(e) is only: verbatim move of the anonymous builder, +1 import, +1 arg at :7652, +1 arg at :7678, -1 import identifier at :413 — none of these thread a community-name FACT into the greeting decision, and no lane task names the mechanism by which the resolved pack FACT reaches :1233. As written, the welcome intent would either stay hardcoded 'Maxina' (not tenant-branded — a silent failure of the whole program's goal) or require an unenumerated signature change to GreetingDecisionContext and its 5+ call sites that is entirely absent from the plan.

- `exafyltd/vitana-platform:services/gateway/src/services/conversation/compute-greeting-decision.ts:1232` — const welPrompt = buildOpeningIntentDirective(
        `${firstTimeNamePart(ctx.firstName)}This is their very first voice conversation. Welcome them warmly to Maxina, ` +
- `exafyltd/vitana-platform:services/gateway/src/services/conversation/compute-greeting-decision.ts:238` — export interface GreetingDecisionContext {
    // --- transport / path routing
- `exafyltd/vitana-platform:services/gateway/src/services/conversation/compute-greeting-decision.ts:1265`
- `exafyltd/vitana-platform:services/gateway/src/services/conversation/compute-greeting-decision.ts:21` — IMPURITY IS INJECTED, NOT PERFORMED. Every value the live path derives from the clock ... is passed in already resolved

Suggestion: Enumerate exactly how the per-tenant community-name FACT reaches the first-time-welcome directive. Either (a) add a `communityName: string` (or `brand`/`tenantFacts`) field to GreetingDecisionContext, thread it from the resolved pack at every computeGreetingDecision call site (the plan's header says there are 5+), and replace the literal 'Maxina' at :1233 with that field defaulting to 'Maxina'; or (b) drop the F4 claim and explicitly mark the welcome intent's community name as out of scope of this slice (keeping 'Maxina' hardcoded), being honest that pre-login tenant branding does NOT yet reach this surface. The golden fixture must cover the renamed tenant's name if (a). List the changed call sites against the §8 hot-file cap.

### R2-F2 [major]

Golden-byte-identical for the resolved-pack default of the first-time welcome intent is asserted but the mechanism is unspecified. The F4 bullet says the intent 'takes the community name as a FACT from the resolved pack (default Maxina → byte-identical)' and the golden fixture 'covers ... the first-time welcome intent'. But if the community name becomes a FACT parameter defaulting to 'Maxina', the directive text at :1233 must be regenerated as `Welcome them warmly to ${communityName}` rather than the literal, and the plan does not record which value the golden fixture pins (the string 'Maxina' vs the resolved variable). More importantly, the 'no-hardcoded-spoken-wording' rule-41 guard reads source files for finished spoken sentences; the inline English intent 'Welcome them warmly to Maxina' at :1233 is exactly the class of hardcoded tenant FACT the program is meant to neutralise, yet no lane task says to change compute-greeting-decision.ts:1233 itself (only the person/brand paths are named, and compute-greeting-decision.ts's only listed edit in R1-F2/R1-F3 responses is that its import of buildFirstTimeWelcomeLine is not touched).

- `exafyltd/vitana-platform:services/gateway/src/services/conversation/compute-greeting-decision.ts:1233` — This is their very first voice conversation. Welcome them warmly to Maxina, 

Suggestion: Name compute-greeting-decision.ts:1233 explicitly in the persona-pack lane paths and task list, and specify that the literal 'Maxina' is replaced with the resolved community-name FACT (with the golden fixture asserting both the default Maxina byte-equality and a fixture tenant's name). If the lane does NOT edit :1233, the plan must state that the welcome intent remains a hardcoded Maxina literal and remove the claim that it is tenant-branded.

## Acknowledgements of earlier responses

- R1-F1: acknowledged — Confirmed getPersonalityConfigSync does exist at ai-personality-service.ts:460 (my round-1 conclusion that it did not was wrong — the symbol is defined there even though my earlier read truncated before :460). The revised premise and the getEffectiveConfigSync/tenantConfigCache design are sound.
- R1-F2: acknowledged — The delete-buildFirstTimeWelcomeLine approach and guard-test extension are correct and the dead-code evidence is plausible.
- R1-F3: acknowledged — The tenant_slug contract, getTenantIdBySlug, and the enumerated orb-live.ts diff are now fully specified and consistent with the code I read (no bySlug map today, LiveSessionStartRequest has no tenant field).
- R1-F4: acknowledged — The FIXED vs TENANT field map and the golden-fixture coverage of full assembled output are a reasonable resolution; the stale-reader note for tenure_opening_shapes/last_interaction_acknowledgements is plausible.

## Next

Planner: answer every finding above in `sparring/s2-responses-2.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
