# Sparring round 2 — in_progress

Session: `2cc96038-ed5f-40e6-b7df-b6595046f5a7` · plan hash `ecc1dda469b3c2aa0bfdc0a736d77acb339b875b2a5e0eb1d7e0817c8e91c083`

## Summary

All five R1 findings were accepted and are addressed in the revised plan. One new major finding (R2-F1): the lane-5 `…0001` lint-test carve-out is simultaneously self-contradictory (it exempts the two slug-map sites that lane 5a removes) and incomplete (it does not exempt `services/gateway/src/lib/vitana-bot.ts:9`, which holds a legitimate, intentional `…0001` use as the bot user ID). The two flaws interact: the stale slug-map carve-out creates a false safe harbour for partial removal, while the missing `vitana-bot.ts` carve-out means the test will either spuriously fail or be silently scoped away from `vitana-bot.ts`, giving false assurance.

## Findings

### R2-F1 [major]

The lane-5 Vitest `…0001` lint assertion carves out 'the two slug-map sites' that lane 5a is removing, creating a false safe harbour for partial removal, and simultaneously omits `services/gateway/src/lib/vitana-bot.ts:9` (`VITANA_BOT_USER_ID = '00000000-0000-0000-0000-000000000001'`) — a legitimate, intentional `…0001` use as the bot user ID that the test will encounter on every run.

- `exafyltd/vitana-platform:services/gateway/src/lib/vitana-bot.ts:9` — export const VITANA_BOT_USER_ID = '00000000-0000-0000-0000-000000000001';
- `exafyltd/vitana-platform:services/gateway/src/routes/me.ts:15` — const TENANT_SLUGS: Record<string, string> = {
  '00000000-0000-0000-0000-000000000001': 'vitana',
  '00000000-0000-0000-0000-000000000002': 'maxina',
  '00000000-0000-0000-0000-000000000003': 'alkalma',
  '00000000-0000-0000-0000-000000000004': 'earthlings',
};
- `exafyltd/vitana-platform:services/gateway/src/routes/dev-auth.ts:26` — const SLUG_TO_TENANT_ID: Record<string, string> = {
  'vitana': '00000000-0000-0000-0000-000000000001',
  'maxina': '00000000-0000-0000-0000-000000000002',
  'alkalma': '00000000-0000-0000-0000-000000000003',
  'earthlings': '00000000-0000-0000-0000-000000000004',
};
- `exafyltd/vitana-platform:docs/MULTI-TENANT-PLAN.md:28` — NOTE: `…0001` is BOTH the dev tenant id (`orb-memory-bridge.ts:66-70`) AND the bot user id (`lib/vitana-bot.ts:9`) — in `fire_welcome_chat_on_membership`/`notify_on_chat_message` it is the bot USER id (tenant comes from NEW.tenant_id), so those functions are not tenant-hardcoded.
- `exafyltd/vitana-platform:supabase/migrations/20260625000000_alle_beisammen_chat_group.sql:55` — v_bot          UUID := '00000000-0000-0000-0000-000000000001';

Suggestion: Replace the test assertion with: 'no `…0001` literal survives in gateway TypeScript source outside (1) `services/gateway/src/lib/vitana-bot.ts` (VITANA_BOT_USER_ID — bot user ID, intentional per program plan §2) and (2) `DEV_IDENTITY`'s resolved `DEV_TENANT_SLUG` default in `orb-memory-bridge.ts`.' Remove the stale 'two slug-map sites' carve-out — those files are deleted by lane 5a, so exempting them from the lint allows a partially-applied lane 5a to pass undetected. Add the `vitana-bot.ts` carve-out explicitly so the test does not fail spuriously and the reviewer can see exactly what is intentionally allowed.

## Acknowledgements of earlier responses

- R1-F1: acknowledged — Addressed. The revised plan explicitly specifies REVOKE ALL ON public.tenant_claim_mismatch_log FROM PUBLIC, anon, authenticated; GRANT ALL TO service_role; ENABLE RLS with no policy in lane 3, and adds a pgTAP test asserting authenticated deny and service_role admit.
- R1-F2: acknowledged — Addressed. The revised plan correctly splits the two shapes: (a) slug maps at me.ts:15+23 and dev-auth.ts:26 are removed, resolving via DB registry + TenantContext; (b) DEV_IDENTITY.TENANT_ID/TENANT_SLUG is driven by DEV_TENANT_SLUG env var defaulting to 'vitana'. The test clause introduced by this fix contains a new defect that is raised as R2-F1.
- R1-F3: acknowledged — Addressed. The revised plan now includes explicit TypeScript signatures for the O1 contract: type TENANT_TABLES, isHealthTable(tableName: string): boolean, tenantDb(ctx: TenantContext), and healthDb(userId: string) in lane 5.
- R1-F4: acknowledged — Addressed in the sub-plan. The revised plan correctly splits the cost claim: (select tenant_id_for_policies()) is uncorrelated and hoists to an initPlan on user-private tables; (select is_member(tenant_id)) is correlated on the outer column, per-row on tenant-shared tables. Note that docs/MULTI-TENANT-PLAN.md line 53 at the pinned commit still carries the un-split wording, but that is the program plan document and would be updated as part of this plan's implementation.
- R1-F5: acknowledged — Addressed. The revised plan now explicitly states the dual-write trigger body uses INSERT INTO user_tenants … ON CONFLICT (tenant_id, user_id) DO NOTHING for the steady-state path, and adds a pgTAP test that re-inserting a known memberships row creates zero extra chat_messages, founding seats, autopilot rows, and live rooms.

## Next

Planner: answer every finding above in `sparring/s2-responses-2.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
