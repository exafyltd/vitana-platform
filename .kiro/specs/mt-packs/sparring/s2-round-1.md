# Sparring round 1 — in_progress

Session: `eb308b4e-c1f4-442f-8624-0b92becdecee` · plan hash `c8e50bf845dfce2a7147a92647b96aadcfb58e0185217f1ea7363f1bff6e9dc8`

## Summary

The plan is well-scoped and mostly accurate about the existing code. I verified 6 distinct premises against the code. Core observation: the Maxina hardcoding diagnosis is correct across persona, anonymous builder, welcome line, and KB references. However, the plan contains a material factual error about the existing codebase: it claims a `getPersonalityConfigSync` function exists at ai-personality-service.ts:26/:576/:594, but that file (802 lines, fully read) defines only the async `getPersonalityConfig`/`getEffectiveConfig` — `getPersonalityConfigSync` is defined and *called* elsewhere (live-system-instruction.ts imports and calls it), not in ai-personality-service.ts. The plan's F1 design ("mirrors getPersonalityConfigSync" and "a getEffectiveConfigSync over a session-start cache") rests on a sync cache primitive that does not exist in this service and would need to be built, which is under-scoped/under-explained given the sync-vs-async constraint is the central risk of the lane. Additionally, the rule-41 guard test (no-hardcoded-spoken-wording.test.ts) does NOT scan greeting-pools.ts today, so the "rule-41 guard test" for buildFirstTimeWelcomeLine needs to be added to the existing characterization guard or the violation will remain unguarded. The anonymous tenant-slug plumbing premise (widget passes slug to anonymous session-start endpoint) implies a new endpoint contract but the anonymous session has no JWT and the server-side slug→tenantId validation path is not yet evidenced, leaving F2/F3 with an unproven request/transport assumption.

## Findings

### R1-F1 [major]

The plan's F1 core design premise is factually wrong: it states getPersonalityConfigSync is at ai-personality-service.ts:26/:576/:594 and that the tenant config should be 'PRE-FETCHED ... mirroring getPersonalityConfigSync' with a new 'getEffectiveConfigSync'. Reading the entire 802-line ai-personality-service.ts shows it defines ONLY async getPersonalityConfig / getEffectiveConfig / getTenantAssistantConfig / upsertTenantAssistantConfig / warmPersonalityCache — there is NO getPersonalityConfigSync and NO getEffectiveConfigSync in this service. The line numbers 576/594 are the calls in live-system-instruction.ts, not the definition site.

- `exafyltd/vitana-platform:services/gateway/src/services/ai-personality-service.ts:651` — export async function getEffectiveConfig(
    surfaceKey: PersonalitySurfaceKey,
    tenantId: string | null
  ): Promise<Record<string, unknown>> {
- `exafyltd/vitana-platform:services/gateway/src/services/ai-personality-service.ts:792` — export async function warmPersonalityCache(): Promise<void> ... await getPersonalityConfig(key)
- `exafyltd/vitana-platform:services/gateway/src/orb/live/instruction/live-system-instruction.ts:576` — const voiceLiveConfig: Record<string, any> = { ...(getPersonalityConfigSync('voice_live') as Record<string, any>) };

Suggestion: Locate where getPersonalityConfigSync actually lives (it is imported by live-system-instruction.ts; ai-personality-service.ts exposes only async variants) and correct the premise. If a sync session-start cache does not exist, the F1 design must explicitly BUILD one (cache populated at session bootstrap, read synchronously) and the plan must name the exact file/function, otherwise the 'no async cascade' constraint is not actually solvable as written. Add the definition location to the plan and a premise-traced test that the sync path returns tenant-resolved config.

### R1-F2 [major]

The claimed rule-41 guard for buildFirstTimeWelcomeLine will not actually guard it unless the existing characterization test is extended. greeting-pools.ts's buildFirstTimeWelcomeLine (lines 177-187) returns finished spoken sentences with 'Maxina' literals in de/en/es/sr — a live rule-41 violation — but the existing rule-41 characterization test reads ONLY orb-live.ts, compute-greeting-decision.ts, reconnect-recovery-prompt.ts and voice-wake-brief.ts; it does NOT read greeting-pools.ts. A 'rule-41 guard test' would not fire on this file unless the plan explicitly adds greeting-pools.ts to the scanned files or writes a new targeted assertion.

- `exafyltd/vitana-platform:services/gateway/src/orb/instruction/greeting-pools.ts:181` — de: `Hallo${nm}, ich bin Vitana ... Herzlich willkommen bei Maxina! ...`, en: `Hi${nm}, I'm Vitana ... Welcome to Maxina! ...`
- `exafyltd/vitana-platform:services/gateway/test/orb/live/characterization/no-hardcoded-spoken-wording.test.ts:27` — const orbLiveRaw = readFileSync(join(__dirname, '../../../../src/routes/orb-live.ts'), 'utf8');
  const greetingDecisionRaw = readFileSync(... compute-greeting-decision.ts ...);
  const recoveryPromptRaw = readFileSync(... reconnect-recovery-prompt.ts ...);
  const wakeBriefRaw = readFileSync(... voice-wake-brief.ts ...);
- `exafyltd/vitana-platform:services/gateway/test/orb/instruction/first-time-welcome.test.ts:24` — const line = buildFirstTimeWelcomeLine('fr', null);
      expect(line).toMatch(/Welcome to Maxina/);

Suggestion: Explicitly name the mechanism: extend no-hardcoded-spoken-wording.test.ts to read greeting-pools.ts (and any other INTENT-emitting surface) and assert no finished spoken sentence remains, OR add a dedicated guard test that buildFirstTimeWelcomeLine emits only FACTS+INTENTS. Also reconcile with first-time-welcome.test.ts which currently asserts the literal 'Welcome to Maxina' string — that test must be rewritten to match the new intent-based output, not left asserting the removed literal.

### R1-F3 [major]

F2/F3's anonymous tenant-slug transport is an unproven premise: the plan says 'the widget passes a slug/host to the anonymous session-start endpoint (frontend-brand-neutralise F2)' and the server VALIDATES it against tenants, but the anonymous path has no JWT and no resolved TenantContext (confirmed — buildAnonymousSystemInstruction is called with session.clientContext only, no tenantId). There is no existing anonymous session-start endpoint that accepts a tenant slug, and the plan introduces a new request contract without specifying which endpoint/payload field carries the slug, how it reaches buildAnonymousSystemInstruction, or how the validated tenantId is threaded into a builder that today takes only (lang, voiceStyle, ctx, conversationHistory, isReconnect).

- `exafyltd/vitana-platform:services/gateway/src/routes/orb-live.ts:7651` — : (session.isAnonymous
                  ? buildAnonymousSystemInstruction(
                      session.lang,
- `exafyltd/vitana-platform:services/gateway/src/routes/orb-live.ts:7413` — function buildAnonymousSystemInstruction(lang: string, voiceStyle: string, ctx?: ClientContext, conversationHistory?: string, isReconnect?: boolean): string {
- `exafyltd/vitana-platform:services/gateway/src/services/tenancy/tenant-context.ts:24` — export interface TenantContext {
  tenantId: string;
  slug: string | null;
  role: string | null;
  source: TenantSource;
  isPlatform: boolean;
}

Suggestion: Specify the exact session-start endpoint and payload field for the anonymous slug, the server-side validation call (e.g. getTenantMeta/getDefaultTenantId or a slug→tenantId lookup), and the exact new signature of the extracted buildAnonymousSystemInstruction. The plan claims 'one-argument call-site change' only for the authenticated builder but F2/F3 also changes the anonymous builder's signature and its call site — that diff must be enumerated against the §8 hot-file cap.

### R1-F4 [minor]

The plan's statement 'Voice_live.base_identity begins You are Vitana ... of the Maxina Community' is correct, but the split's scope is under-described: persona-pack also needs to handle the tenure_opening_shapes (lines 138-153) and last_interaction_acknowledgements (159-174) blocks, which embed 'Vitanaland', 'longevity mission', and platform/mission references within voice_live defaults. The plan says 'split voice_live.base_identity (and other surface defaults embedding tenant facts)' but does not enumerate these blocks, so the tenant-block extraction boundary is incompletely specified for golden-byte-identical Maxina reproduction.

- `exafyltd/vitana-platform:services/gateway/src/services/ai-personality-service.ts:143` — 'name the platform: Vitanaland — longevity mission (improve quality of life, extend lifespan)',
- `exafyltd/vitana-platform:services/gateway/src/services/ai-personality-service.ts:137` — tenure_opening_shapes: { day0: { ... required_elements: [ 'brief warm by-name greeting', 'name the platform: Vitanaland ...' ...

Suggestion: Enumerate which voice_live defaults fields (base_identity, tenure_opening_shapes, last_interaction_acknowledgements, forbidden_openings, etc.) are treated as FIXED vs TENANT-driven, and ensure the golden fixture covers the full assembled instruction including these blocks, not just base_identity.

## Next

Planner: answer every finding above in `sparring/s2-responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
