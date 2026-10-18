# Sparring round 1 — in_progress

Session: `1896989e-d566-482a-ae2f-56784ba0d901` · plan hash `84f1140d773cc9f66f13efa52e404922fc70ba532100098bbffd07e1739de80e`

## Summary

The plan correctly identifies the tenant-isolation gaps and the persona/KB split problem, and the dependency ordering is sound. However, two blockers and two majors must be resolved before implementation: (1) the central instruction builder is synchronous and cannot call the async `getEffectiveConfig` without a cascading async conversion that violates the declared hot-file cap; (2) `buildAnonymousSystemInstruction` — the primary Maxina-literal function in the anonymous path — is 128 lines inside the hot file and cannot be made tenant-aware within the ≤20-line constraint; (3) anonymous sessions have no resolved TenantContext, so the mechanism for passing pre-login tenant identity into the server-side anonymous builder is unspecified; (4) `buildFirstTimeWelcomeLine` in `greeting-pools.ts` contains finished spoken sentences with hardcoded "Maxina" brand that fall in no lane's scope.

## Findings

### R1-F1 [blocker]

`buildLiveSystemInstruction` is synchronous and imports `getPersonalityConfigSync`; the plan directs it to call the async `getEffectiveConfig` without explaining how to cross the sync/async boundary, and any fix that makes the builder async cascades to multiple call sites inside the 19 279-line `orb-live.ts`, violating the declared ≤20-line hot-file constraint.

- `exafyltd/vitana-platform:services/gateway/src/orb/live/instruction/live-system-instruction.ts:26` — import { getPersonalityConfigSync } from '../../../services/ai-personality-service';
- `exafyltd/vitana-platform:services/gateway/src/services/ai-personality-service.ts:658` — export async function getEffectiveConfig(
  surfaceKey: PersonalitySurfaceKey,
  tenantId: string | null
): Promise<Record<string, unknown>> {
  // Layer 1: global config (defaults + any global DB override)
  const globalConfig = await getPersonalityConfig(surfaceKey);
- `exafyltd/vitana-platform:services/gateway/src/routes/orb-live.ts:7678` — : buildLiveSystemInstruction(
    session.lang,
    session.voiceStyle || 'friendly, calm, empathetic',

Suggestion: Either (a) introduce a `getEffectiveConfigSync(surfaceKey, tenantId)` that reads from a pre-warmed in-process tenant-config cache populated at session-start (mirroring the existing `getPersonalityConfigSync` pattern), or (b) pre-fetch the tenant config before building the instruction envelope and pass the resolved config object into `buildLiveSystemInstruction` as a parameter. Document whichever approach is chosen and add a test that verifies the tenant config is available synchronously at instruction-build time. The plan must also specify how the resolved tenant config flows from session context to the builder so call sites in `orb-live.ts` require only a parameter addition, not an async refactor.

### R1-F2 [blocker]

`buildAnonymousSystemInstruction` is 128 lines entirely inside `orb-live.ts` (lines 7413–7541) and contains extensive hardcoded Maxina literals throughout its body. The plan targets this function in lane `persona-pack` while simultaneously declaring '`orb-live.ts` large edits beyond ≤20-line hot-file touches' out of scope. The two constraints are irreconcilable as written.

- `exafyltd/vitana-platform:services/gateway/src/routes/orb-live.ts:7413` — function buildAnonymousSystemInstruction(lang: string, voiceStyle: string, ctx?: ClientContext, conversationHistory?: string, isReconnect?: boolean): string {
- `exafyltd/vitana-platform:services/gateway/src/routes/orb-live.ts:7437` — return `You are Vitana — the AI voice companion and brand presenter for the Maxina Community on Vitanaland.com.
- `exafyltd/vitana-platform:services/gateway/src/routes/orb-live.ts:7492` — - Origin story: they've landed on Vitanaland, home of the Maxina Community. Maxina was created around Mariia Maksina — a professional dancer many people already know and love from the TV show Let's Dance.
- `exafyltd/vitana-platform:services/gateway/src/routes/orb-live.ts:7541` — You have NO tools available in this anonymous session. Do NOT attempt to call any
function or tool.

Suggestion: Extract `buildAnonymousSystemInstruction` into its own module (e.g., `orb/live/instruction/anonymous-system-instruction.ts`) as a prerequisite step — mirroring how `buildLiveSystemInstruction` was already lifted out of `orb-live.ts` into `orb/live/instruction/live-system-instruction.ts`. The extraction itself is a behaviour-identical move and can be gated by a snapshot test before any tenant-parameterisation is added. This keeps the `orb-live.ts` change to the ~3-line import+call update that the hot-file rule allows, while the substantive Maxina→FACTS/INTENTS split happens in the new module.

### R1-F3 [major]

Anonymous (pre-login) sessions have no resolved `TenantContext` / `tenantId`. The plan states instruction builders key on `ctx.tenantId` from the resolved `TenantContext`, but `buildAnonymousSystemInstruction` is specifically the unauthenticated path where no JWT claim and no tenant resolution exists. Lane `frontend-brand-neutralise` says 'widget passes tenant pre-login context (host/slug)' but the plan never describes how that slug is received, validated, and threaded into the server-side anonymous instruction builder to populate `tenantId`.

- `exafyltd/vitana-platform:services/gateway/src/routes/orb-live.ts:7651` — session.isAnonymous
  ? buildAnonymousSystemInstruction(
      session.lang,
      session.voiceStyle || 'friendly, calm, empathetic',
      session.clientContext,
- `exafyltd/vitana-platform:services/gateway/src/routes/orb-live.ts:7413` — function buildAnonymousSystemInstruction(lang: string, voiceStyle: string, ctx?: ClientContext, conversationHistory?: string, isReconnect?: boolean): string {

Suggestion: Add an explicit sub-lane or step that: (1) defines how the frontend widget passes a tenant slug/host to the session-start endpoint for anonymous sessions; (2) describes the server-side validation of that slug (lookup against `tenants`, not trusted from the client); (3) threads the resolved `tenantId` into `buildAnonymousSystemInstruction` as a new parameter. Without this, even after lanes `persona-pack` and `frontend-brand-neutralise` ship, a new tenant's anonymous landing page will still serve the Maxina story verbatim.

### R1-F4 [major]

`buildFirstTimeWelcomeLine` in `orb/instruction/greeting-pools.ts` (lines 181–186) emits finished spoken sentences that hard-code 'Welcome to Maxina!' / 'Herzlich willkommen bei Maxina!' etc. across multiple locales. This is a Rule 41 violation and a Maxina literal in the voice path. It is not assigned to any lane: `brand-content-templating` explicitly restricts `{{brand}}` to 'UI/push/email and tt() catalog entries (never spoken strings)', and `persona-pack` targets instruction builders, not this pool function.

- `exafyltd/vitana-platform:services/gateway/src/orb/instruction/greeting-pools.ts:177` — export function buildFirstTimeWelcomeLine(lang: string, firstName: string | null): string {
  ...
  de: `Hallo${nm}, ich bin Vitana, deine persönliche Longevity-Assistentin. Herzlich willkommen bei Maxina! Ich begleite dich...',
  en: `Hi${nm}, I'm Vitana, your personal longevity assistant. Welcome to Maxina! I'll guide you step by step...`,

Suggestion: Assign `buildFirstTimeWelcomeLine` to lane `persona-pack` (not `brand-content-templating`): replace the finished spoken sentences with FACTS+INTENTS that the model assembles per Rule 41, sourcing the community name from the resolved tenant pack exactly as the other voice-path builders will do. Add a Rule 41 guard test asserting no finished brand sentence passes through this function. The existing Maxina output must be golden-matched.

### R1-F5 [minor]

`checklist-regenerate.ts` resolves the KB manual directory via hardcoded `__dirname`-relative filesystem candidates to `kb/instruction-manual/maxina` (lines 124–130), not via a configurable 'pack id'. Lane `kb-overlay-code` says 'default `maxina` kept as the baseline pack id' implying a lookup, but no such abstraction exists in the current code.

- `exafyltd/vitana-platform:services/gateway/src/services/guided-journey/checklist-regenerate.ts:122` — function resolveManualDir(): string | null {
  const candidates = [
    path.join(__dirname, '../../kb/instruction-manual/maxina'),
    path.join(__dirname, '../../../kb/instruction-manual/maxina'),
    path.join(process.cwd(), 'dist/kb/instruction-manual/maxina'),
    path.join(process.cwd(), 'src/kb/instruction-manual/maxina'),
    path.join(__dirname, '../../../src/kb/instruction-manual/maxina'),
  ];

Suggestion: Lane `kb-overlay-code` must include a concrete design for how `checklist-regenerate.ts` (and similar hardcoded consumers like `retrieval-router.ts` and `orb-tools-shared.ts`) is updated to accept a resolved tenant pack id and derive the correct KB path, rather than assuming a configurable baseline already exists. The plan's description of 'default `maxina` kept as the baseline pack id' implies an abstraction that must be built, not one that already exists.

## Next

Planner: answer every finding above in `sparring/s2-responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
