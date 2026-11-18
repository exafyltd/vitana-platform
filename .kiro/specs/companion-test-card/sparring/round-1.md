# Sparring round 1 — in_progress

Session: `97e421c8-09eb-4d71-94b8-bb09b5d32ff1` · plan hash `1e4829dc57a7f54786e2399843e630558ee047d6a4324ff9c42eacf9e1f31440`

## Summary

Plan is well-structured with thorough coverage of error states, auth, rate limiting, and side-effect isolation (no ledger, no pacer, no push). Premises about the existing companion routes, config resolution, MemberContext shape, moment building, delivery, and auth middleware all hold. I found one major concern about the Supabase client choice and one minor concern about MemberContext construction completeness.

## Findings

### R1-F1 [major]

The plan adds the test-card route to `routes/companion.ts`, which currently uses `getSupabase()` for its Supabase client (lines 48, 66). However, the test card needs to insert into `chat_messages` with `sender_id = VITANA_BOT_USER_ID` (not the authenticated user). The companion tick obtains its client via `getServiceClient()` (scheduled-notifications.ts:1766), which is a service-role client that bypasses RLS. If the test-card route follows the existing companion.ts pattern and uses `getSupabase()`, the `chat_messages` insert will likely fail because RLS policies would not allow the authenticated user to insert a row where `sender_id` is a different user (the bot). The plan should explicitly specify that a service-role client is required for the insert step.

- `exafyltd/vitana-platform:services/gateway/src/routes/companion.ts:48` —   const sb = getSupabase();
    if (!sb) return res.status(503).json({ ok: false, error: 'storage_unavailable' });
- `exafyltd/vitana-platform:services/gateway/src/routes/scheduled-notifications.ts:1766` —     const supa = await getServiceClient();
    if (!supa) return res.status(503).json({ ok: false, error: 'Supabase not configured' });
- `exafyltd/vitana-platform:services/gateway/src/services/companion/companion-repository.ts:396` — export async function insertCompanionChatMessage(
  sb: SupabaseClient,
  row: CompanionChatMessageRow,
): Promise<{ id: string | null; error: string | null }> {
  const { data, error } = await sb.from('chat_messages').insert(row).select('id').single();
  if (error) return { id: null, error: error.message };
  return { id: ((data as { id?: string } | null)?.id) ?? null, error: null };

Suggestion: Explicitly state in the plan that the test-card route must use `getServiceClient()` (the service-role Supabase client) for the `insertCompanionChatMessage` call, not the `getSupabase()` used by the existing preference routes in the same file. This mirrors the tick's approach. The injectable `sb` dep should receive the service-role client.

### R1-F2 [minor]

The plan says MemberContext is built 'the same way the tick does for one member' but the tick's MemberContext includes `eligibleEnrichmentCardTypes` (companion-service.ts:219) and spread `memberSignals` (companion-service.ts:220) providing `journey`, `diaryLastEntryDate`, `activeDays`, `recentFeatureTips`. The plan's simplified construction (topics all on, lastUsed empty, no signals, no enrichment) is safe because all these fields are optional in the MemberContext type and the route only calls `vitanaIndex.build()` directly (which reads only `ctx.vitanaIndex`). However, if the route later supports other moment_keys (the plan mentions the enum makes this a one-line change), those moments may require these fields (e.g. guided_journey_step needs `journey`, diary_nudge needs `diaryLastEntryDate`). The plan should note this limitation for future extensibility.

- `exafyltd/vitana-platform:services/gateway/src/services/companion/moments.ts:22` — export interface MemberContext {
  userId: string;
  tenantId: string;
  firstName: string | null;
  locale: string;
  localDate: string;
  topics: Record<CompanionTopic, boolean>;
  vitanaIndex: VitanaIndexSnapshot | null;
  /** moment_key → most recent local date it was used (any mode). */
  lastUsed: Record<string, string>;
  ...
  eligibleEnrichmentCardTypes?: ReadonlySet<string>;
}
- `exafyltd/vitana-platform:services/gateway/src/services/companion/companion-service.ts:206` —         const ctx: MemberContext = {
          userId: m.user_id,
          tenantId: m.tenant_id,
          firstName: m.firstName,
          locale: localeMap.get(m.user_id) ?? 'de',
          localDate: m.date,
          topics: {
            health: pref?.topic_health ?? true,
            community: pref?.topic_community ?? true,
            business: pref?.topic_business ?? false,
          },
          vitanaIndex: index,
          lastUsed,
          eligibleEnrichmentCardTypes,
          ...memberSignals(signals.by.get(m.user_id), rows, m.date),
        };

Suggestion: Add a brief note in the Decisions section that the simplified MemberContext (no signals, no enrichment eligibility) is correct for vitana_index-only but that adding other moment_keys later will require populating those optional fields.

### R1-F3 [minor]

The plan says `composeCompanionMessage` uses `providerOverride: 'bedrock'` (composer.ts:80), which satisfies the Bedrock-only LLM routing governance rule. However, the plan does not explicitly state that the test-card composition also goes through Bedrock. Since the plan reuses `composeCompanionMessage` without copying logic, this is implicitly satisfied, but it would be clearer to state it explicitly for the governance gate reviewer.

- `exafyltd/vitana-platform:services/gateway/src/services/companion/composer.ts:74` —     result = await call(STAGE, buildComposePrompt(ctx, moment), {
        vtid: VTID,
        service: 'companion-messages',
        systemPrompt: buildLocalizedSystemPromptForLang(COMPANION_BASE_PROMPT, ctx.locale),
        maxTokens: 400,
        providerOverride: 'bedrock',
        modelOverride: config.model,
        fallbackOverride: { provider: 'bedrock', model: config.fallbackModel },
      });

Suggestion: Add a sentence in the Decisions section: 'Composition reuses `composeCompanionMessage`, which hardcodes `providerOverride: "bedrock"` and `fallbackOverride.provider: "bedrock"` — the Bedrock-only routing rule is satisfied by construction.'

## Next

Planner: answer every finding above in `sparring/responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
