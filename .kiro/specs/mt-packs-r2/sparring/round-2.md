# Sparring round 2 — converged

Session: `6ecddfb3-fdbc-44f6-a7af-1038ad8bb9df` · plan hash `5a9c889fddd855c03b5de1bed27790a92102dfb27fc6355a19342b57205b86e9`

## Summary

Round 2 review of the revised mt-packs plan. The accepted R1-F1 finding (extra_config overwrite of pack_facts and FIXED fields) has been substantively addressed: the plan now specifies (a) the FIXED block reads only from the global config or code, never from the tenant-merged object, (b) pack_facts passes through a new parsePackFacts validator with allowlisted keys, and (c) tests cover bogus extra_config.pack_facts and extra_config setting FIXED keys. All key premises verified against the pinned commit hold. No new blocker or major findings identified. One minor observation raised.

## Findings

### R2-F1 [minor]

The plan passes the prewarmed tenant config to `buildLiveSystemInstruction` as 'one new trailing parameter'. The function already has 12+ positional parameters (lines 463–480+). Adding another positional argument to such a long signature increases the risk of argument-position errors at the call site and makes the function harder to maintain. A named-options object for at least the new tenant-related parameters would be safer.

- `exafyltd/vitana-platform:services/gateway/src/orb/live/instruction/live-system-instruction.ts:463` — export function buildLiveSystemInstruction(
    lang: string,
    voiceStyle: string,
    bootstrapContext?: string,
    activeRole?: string | null,
    conversationSummary?: string,
    conversationHistory?: string,
    isReconnect?: boolean,
    lastSessionInfo?: { time: string; wasFailure: boolean } | null,
    currentRoute?: string | null,
    recentRoutes?: string[] | null,
    clientContext?: ClientContext,
    vitanaId?: string | null,

Suggestion: Consider passing the new tenant config (and ideally the existing trailing parameters) as a typed options object rather than yet another positional argument. This is a code-quality improvement, not a correctness issue — the hot-file cap and golden tests mitigate the risk.

## Acknowledgements of earlier responses

- R1-F1: acknowledged — Accepted and properly addressed. The revised plan closes both override channels at the reader: (1) FIXED block reads only global config via getPersonalityConfigSync, confirmed at live-system-instruction.ts:576; (2) pack_facts pass through parsePackFacts with allowlisted keys, string-only, length caps; (3) tests explicitly cover extra_config containing pack_facts and FIXED keys. The design is sound.
