# Sparring responses — session 1896989e-d566-482a-ae2f-56784ba0d901, round 1

```json
[
  {
    "finding_id": "R1-F1",
    "disposition": "accepted",
    "rationale": "Verified buildLiveSystemInstruction is a SYNC export function (services/gateway/src/orb/live/instruction/live-system-instruction.ts:463) that reads getPersonalityConfigSync (import :26, calls :576 and :594); the async getEffectiveConfig (ai-personality-service.ts:659) cannot be dropped in without an async cascade to the orb-live.ts call site (:7678), which the program section 8 hot-file cap forbids. Keeping option (b): pre-fetch the tenant config at session start and pass the resolved config OBJECT into the builder as a new parameter (one-argument addition at the call site, no async conversion), plus a getEffectiveConfigSync(surfaceKey, tenantId) over a session-start-prewarmed cache mirroring getPersonalityConfigSync for builders off the envelope path. plan.md Fix (persona-pack), Problem #3, Tests and tasks.md P2 updated; a test asserts the tenant config is available synchronously at instruction-build time.",
    "deferred_to": null
  },
  {
    "finding_id": "R1-F2",
    "disposition": "accepted",
    "rationale": "Verified buildAnonymousSystemInstruction spans orb-live.ts:7413 to ~:7541 (its return string starts :7437 with the 'Maxina Community' literal, Mariia Maksina origin story at :7492) entirely inside the ~18k-line hot file — it cannot be tenant-parameterised within a <=20-line touch. Adopting the suggestion: extract it verbatim into orb/live/instruction/anonymous-system-instruction.ts (behaviour-identical move, snapshot-gated before any parameterisation, mirroring how buildLiveSystemInstruction was already lifted into live-system-instruction.ts), leaving a ~3-line import+call in orb-live.ts (section 8 compliant). Added services/gateway/src/routes/orb-live.ts to persona-pack lane paths and tasks.md Allowed paths; plan.md Fix/Out-of-scope/Risks and tasks.md P3 updated.",
    "deferred_to": null
  },
  {
    "finding_id": "R1-F3",
    "disposition": "accepted",
    "rationale": "Verified the anonymous builder is called on the unauthenticated path with session.clientContext and no tenantId (orb-live.ts:7651-7652), so there is no resolved TenantContext pre-login. Added the explicit mechanism: the frontend widget passes a tenant slug/host to the anonymous session-start endpoint (frontend-brand-neutralise F2, already scoping src/hooks/useOrbVoiceWidget.ts and src/lib/orbActivate.ts); the server validates the slug against the tenants table (never trusts the client) and threads the resolved tenantId into the extracted anonymous builder as a new parameter; an unknown/absent slug yields null -> Maxina baseline (byte-identical). The server-side handler + builder live in orb-live.ts and the extracted module, both now in persona-pack paths. plan.md Fix (persona-pack), tasks.md P3 and Risks updated.",
    "deferred_to": null
  },
  {
    "finding_id": "R1-F4",
    "disposition": "accepted",
    "rationale": "Verified buildFirstTimeWelcomeLine (orb/instruction/greeting-pools.ts:177) returns finished spoken sentences hardcoding 'Herzlich willkommen bei Maxina!' / 'Welcome to Maxina!' and the Serbian equivalent across de/en/es/sr (:181-:186) — a Rule 41 violation in the voice path, unassigned in the prior plan. greeting-pools.ts is already in persona-pack paths, so no path change is needed; reassigning the fix to persona-pack (not brand-content-templating, which forbids {{brand}} in spoken strings): rewrite it to emit FACTS+INTENTS sourcing the community name from the resolved tenant pack, add a Rule 41 guard test asserting no finished brand sentence passes through, and golden-match the existing Maxina output. plan.md Problem #3, Fix, Tests and tasks.md P3/P5 updated.",
    "deferred_to": null
  },
  {
    "finding_id": "R1-F5",
    "disposition": "accepted",
    "rationale": "Verified resolveManualDir() (services/gateway/src/services/guided-journey/checklist-regenerate.ts:121) hardcodes kb/instruction-manual/maxina across five __dirname/cwd candidates (:124-:129), and retrieval-router.ts:95 and orb-tools-shared.ts:1991 reference the same literal path — the 'baseline pack id' lookup the plan assumed does not exist. kb-overlay-code now states it BUILDS that abstraction: a single helper derives the KB directory from a resolved pack id (default maxina, directory not moved) and each hardcoded consumer calls it. All three files are already in the lane paths, so no path change; plan.md Fix (kb-overlay-code), the lane body and tasks.md K1 updated.",
    "deferred_to": null
  }
]
```
