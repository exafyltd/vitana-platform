# Sparring round 3 — escalated

Session: `eb308b4e-c1f4-442f-8624-0b92becdecee` · plan hash `00c82ef50a5c2cd09f3d5076fc80f18c1f11ca3828f55982d5f6e0598396a85d`

## Summary

R2-F1 and R2-F2 were accepted and are now concretely addressed: GreetingDecisionContext gains optional communityName, :1233 becomes ${ctx.communityName || 'Maxina'}, and diff item (f) enumerates the three context literals (verified present at orb-live.ts:10917/11297/11584, and decide-conversation-flow.ts:144 forwards ctx.greeting). Two new findings remain. (1) BLOCKER: the plan extends no-hardcoded-spoken-wording.test.ts to scan greeting-pools.ts, but greeting-pools.ts still contains SHORT_GAP_GREETING_PHRASES (lines 49-168) — an 11-locale × 8-entry map of finished spoken sentences that the lane does NOT delete; the guard will fail on code the lane doesn't touch, or the scan must be scoped in a way the plan never specifies. (2) MAJOR: the plan claims getTenantIdBySlug is "built on the existing loadTenantFlags() cache (a bySlug map beside byId)" — but tenant-context.ts:70-92 builds only `byId`; there is no bySlug reverse index, so that premise is false and the lookup mechanism is unspecified.

## Findings

### R3-F1 [blocker]

The plan's rule-41 guard extension is self-contradictory. F4 deletes buildFirstTimeWelcomeLine (greeting-pools.ts:177-187) and extends no-hardcoded-spoken-wording.test.ts to read greeting-pools.ts 'so a finished spoken sentence there fails CI'. But greeting-pools.ts ALSO contains SHORT_GAP_GREETING_PHRASES (lines 49-168) — an 11-locale × 8-entry `Record<string,string[]>` map of finished spoken sentences (e.g. 'Welcome back. Let me show you your next step.', 'Ich bin für dich da...'). The lane's diff (a)-(f) does NOT delete or neutralise this pool, and the test file's own documentation (lines 18-22) names exactly this 'per-language map of finished sentences' as the shape the guard exists to block. If the guard scans the whole file, it will fire on SHORT_GAP_GREETING_PHRASES (code the lane leaves untouched), failing CI for a change the lane did not cause; if it scans only buildFirstTimeWelcomeLine's block, the plan's stated guard mechanism is over-broad and unspecified. Either way the plan cannot ship its stated test without also removing/scoping SHORT_GAP_GREETING_PHRASES, which is nowhere enumerated.

- `exafyltd/vitana-platform:services/gateway/src/orb/instruction/greeting-pools.ts:49` — export const SHORT_GAP_GREETING_PHRASES: Record<string, string[]> = {
    en: [
      "Welcome back. Let me show you your next step.",
- `exafyltd/vitana-platform:services/gateway/src/orb/instruction/greeting-pools.ts:177` — export function buildFirstTimeWelcomeLine(lang: string, firstName: string | null): string { ... en: `Hi${nm}, I'm Vitana, ... Welcome to Maxina! ...`
- `exafyltd/vitana-platform:services/gateway/test/orb/live/characterization/no-hardcoded-spoken-wording.test.ts:18` — it pins the exact regressions that happened, plus the SHAPE that invites them (a per-language map of finished sentences).

Suggestion: Resolve the contradiction explicitly: either (a) also delete/neutralise SHORT_GAP_GREETING_PHRASES and pickShortGapGreetings (they are no longer consumed by src/ — the greeting-pools.ts header lines 12-23 documents they were already displaced by INTENTs), updating the characterization test + snapshot; or (b) define the guard scan to target ONLY the finished-sentence block being removed (e.g. name a sentinel/forbid the buildFirstTimeWelcomeLine return shape), and state that explicitly. Enumerate whichever deletion in the diff and the §8/touched-file list so the guard and the deletion stay in sync.

### R3-F2 [major]

The plan says getTenantIdBySlug is 'built on the existing loadTenantFlags() cache (:81-82, a bySlug map beside byId)'. That precedent is false: loadTenantFlags builds ONLY a `byId` Map keyed by tenant_id (line 82 .set(t.tenant_id, ...)), and TenantMeta stores the slug per tenant (byId values) but there is NO bySlug reverse index anywhere in tenant-context.ts. getTenantMeta/getDefaultTenantId operate on byId/defaultId only. So the proposed slug→tenantId lookup has no existing primitive to build on; it requires either a linear scan over byId comparing TenantMeta.slug, or constructing a new bySlug map. The plan's claimed foundation does not exist, so the F2 anonymous-slug validation step is unspecified for its implementation.

- `exafyltd/vitana-platform:services/gateway/src/services/tenancy/tenant-context.ts:79` — const byId = new Map<string, TenantMeta>();
      let defaultId: string | null = null;
      for (const t of data ...) {
        byId.set(t.tenant_id, { slug: t.slug ?? '', isPlatform: ..., isDefault: ... });
        if (t.is_default === true) defaultId = t.tenant_id;
      }
      tenantMetaCache = { byId, defaultId, expiresAt: ... };
- `exafyltd/vitana-platform:services/gateway/src/services/tenancy/tenant-context.ts:95` — export async function getTenantMeta(tenantId: string): Promise<TenantMeta | null> {
  const flags = await loadTenantFlags();
  return flags?.byId.get(tenantId) ?? null;
}

export async function getDefaultTenantId(): Promise<string | null> {
  const flags = await loadTenantFlags();
  return flags?.defaultId ?? null;
}

Suggestion: Correct the premise: state that getTenantIdBySlug must either build a bySlug index from loadTenantFlags()'s byId values (iterating once after cache load), or maintain a separate bySlug Map alongside byId. Name the exact change (a new field in the cache object and one loop line), and note that the slug is stored lowercased/unvalidated today (line 82 stores raw t.slug), so the `^[a-z0-9-]{1,63}$` regex must be applied to the client-supplied slug before lookup. Keep the null-fallback contract intact.

## Acknowledgements of earlier responses

- R2-F1: acknowledged — Accepted and addressed: GreetingDecisionContext gains optional communityName, :1233 becomes ${ctx.communityName || 'Maxina'}, session.packFacts set after prewarm, and diff item (f) adds the field at the three context literals (verified present). Reasonable and complete.
- R2-F2: acknowledged — Accepted and addressed: the literal 'Maxina' at :1233 is explicitly replaced and the golden byte-equality for the default is specified (communityName absent or 'Maxina' reproduces today's exact string). Reasonable.
