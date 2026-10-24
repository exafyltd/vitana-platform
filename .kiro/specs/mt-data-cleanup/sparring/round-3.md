# Sparring round 3 — escalated

Session: `2efa877e-46e8-4355-a2e0-d9b3c30be794` · plan hash `a360a11357cc551e5df193a6fcc517080d9fdb8a6802258d35a087b8082f5746`

## Summary

Round 3. The revision is much stronger: R1-F1/F2 (hot tables already NOT NULL → Lane 4 assert-and-pin), R1-F3 (d48/d49 verified as no-fallback), R1-F4 (precondition gate), and R2-F1 (…0099 user fallback) are all genuinely incorporated and I verified the underlying premises. Two substantive issues remain: (1) premise 3 misattributes the bot-sent chat_messages writer — `fire_welcome_chat_on_membership` never writes `sender_id = …0001`, so the 236 bot rows originate from an out-of-scope gateway writer whose tenant behavior is unverified, which undermines Lane 1's "bot rows → recipient tenant" rule; (2) `contextual_opportunities`/`risk_mitigations` (d48/d49) are populated exclusively by service_role writers (out-of-scope gateway code), not by any repointed migration, so the zero-orphan post-check that enumerates these tables (premise 8) cannot be proven clear and those writers are never repointed.

## Findings

### R3-F1 [major]

Premise 3 misattributes the origin of the 236 bot-sent `chat_messages` rows. The plan asserts 'in `fire_welcome_chat_on_membership` / `notify_on_chat_message` the `…0001` is the bot sender'. But `fire_welcome_chat_on_membership` declares `v_bot := '…0001'` only to EXCLUDE the bot from the recipient list (line 39 `IF v_user_id = v_bot THEN RETURN NEW`; lines 63-66/99-101 exclude `ut.user_id <> v_bot`), and its INSERT writes `sender_id = v_user_id` (the new member) with `tenant_id = v_tenant_id = NEW.tenant_id` — never `sender_id = …0001`. So the 236 bot-sent `chat_messages` rows counted in premise 2 are produced by a different writer (gateway bot-reply path, e.g. via `VITANA_BOT_USER_ID='…0001'`), which this DB-only spec declares out of scope and never verifies. Lane 1's rule 'bot-sent rows → the recipient's tenant derived from the DM peer's/group's tenant' assumes those rows already carry a real tenant; if any were written with the `DEV_IDENTITY.TENANT_ID='…0001'` fallback, they would be `tenant_id=…0001 AND sender_id=…0001`, and the recipient-derivation is circular (the peer may itself be mis-tenanted under `…0001`). The plan neither identifies nor repoints this writer, so the post-check can re-pollute and the column-split analysis cannot be validated without additional investigation.

- `exafyltd/vitana-platform:supabase/migrations/20260601000000_VTID_03089_welcome_chat_db_trigger.sql:29` — v_bot          UUID := '00000000-0000-0000-0000-000000000001';
  v_user_id      UUID := NEW.user_id;
  v_tenant_id    UUID := NEW.tenant_id;
...  IF NEW.is_primary IS NOT TRUE THEN RETURN NEW; END IF;
  IF v_user_id = v_bot          THEN RETURN NEW; END IF;
- `exafyltd/vitana-platform:supabase/migrations/20260601000000_VTID_03089_welcome_chat_db_trigger.sql:84` — SELECT
        v_tenant_id,
        v_user_id,
        ut.user_id,
        v_message,
        'text',
...      WHERE ut.tenant_id = v_tenant_id
        AND ut.user_id <> v_user_id
        AND ut.user_id <> v_bot
- `exafyltd/vitana-platform:services/gateway/src/lib/vitana-bot.ts:9` — export const VITANA_BOT_USER_ID = '00000000-0000-0000-0000-000000000001';
- `exafyltd/vitana-platform:services/gateway/src/services/orb-memory-bridge.ts:66` — USER_ID: '00000000-0000-0000-0000-000000000099',
    // Vitana tenant (primary dev tenant)
    TENANT_ID: '00000000-0000-0000-0000-000000000001',

Suggestion: Before implementation, locate the actual writer that produces `sender_id = …0001` chat_messages (gateway bot-reply / openclaw-bridge path) and confirm it writes a real `tenant_id` (not a `…0001` fallback). If it can ever write `tenant_id = …0001`, either bring that fallback into repointer scope (even if it means a small gateway change, breaking the 'DB-only' declaration) or record an explicit unresolved risk + a post-check that specifically counts `sender_id=…0001 AND tenant_id=…0001` rows and treats them as needing manual review rather than auto-routing to a recipient-derived tenant.

### R3-F2 [major]

d48/d49 tables (`contextual_opportunities`, `risk_mitigations`) are populated exclusively by `service_role` writers, not by any migration being repointed. The 01142/01143 functions are read/dismiss only (verified: `d48_dismiss_opportunity`/`d49_dismiss_mitigation` only SELECT/UPDATE; no INSERT), and their RLS grants INSERT only to `service_role` (01143 line 102 `risk_mitigations_insert_service FOR INSERT TO service_role`; 01142 grants `GRANT SELECT, UPDATE ... TO authenticated`, INSERT only via `service_role`). Premise 8 enumerates these tables in the baseline (counted 'even if zero') and the zero-orphan post-check covers them, but the writers that populate them are gateway service_role automation code that premise 7 explicitly excludes ('no gateway/app code changes', out of scope). Any such writer carrying a `…0001` tenant fallback would re-pollute these tables after Lane 1 and trip the post-check, yet the plan neither repoints nor verifies these writers. This is a re-pollution window the plan cannot close within its declared scope.

- `exafyltd/vitana-platform:database/migrations/20260103_vtid_01142_d48_opportunity_surfacing.sql:129` — GRANT SELECT, UPDATE ON contextual_opportunities TO authenticated;
GRANT ALL ON contextual_opportunities TO service_role;
- `exafyltd/vitana-platform:database/migrations/20260103_vtid_01143_d49_risk_mitigation.sql:102` — CREATE POLICY risk_mitigations_insert_service ON risk_mitigations
  FOR INSERT
  TO service_role
  WITH CHECK (true);
- `exafyltd/vitana-platform:database/migrations/20260103_vtid_01142_d48_opportunity_surfacing.sql:187` — v_user_id := auth.uid();
    IF v_user_id IS NULL THEN
      RETURN jsonb_build_object('ok', false, 'error', 'UNAUTHENTICATED');
    END IF;

    -- Get current status
    SELECT status INTO v_current_status
    FROM contextual_opportunities
    WHERE id = p_opportunity_id AND user_id = v_user_id;
- `exafyltd/vitana-platform:database/migrations/20260103_vtid_01143_d49_risk_mitigation.sql:165` — v_user_id := auth.uid();
    IF v_user_id IS NULL THEN
      RETURN jsonb_build_object('ok', false, 'error', 'UNAUTHENTICATED');
    END IF;

    -- Check if mitigation exists and belongs to user
    SELECT EXISTS(
      SELECT 1 FROM risk_mitigations
      WHERE id = p_mitigation_id AND user_id = v_user_id
    ) INTO v_exists;

Suggestion: Identify the service_role writers that INSERT into `contextual_opportunities` and `risk_mitigations` (gateway automation/engines) and confirm they never emit `tenant_id = …0001`. Either (a) assert-and-pin them in a read-only post-check that greps the gateway code for a `…0001` tenant fallback and fails loudly if found, or (b) add an explicit accepted-risk note with a named owner and a follow-up spec, rather than silently counting these tables 'even if zero' in the baseline. The zero-orphan post-check that enumerates d48/d49 must not be presented as proof of cleanliness while the writers remain unverified and out of scope.

## Acknowledgements of earlier responses

- R2-F1: acknowledged — The revision fully addresses it: premise 7 cites the `…0099` user fallback; Lane 1 removes the `v_user_id := '…0099'` branch and returns UNAUTHENTICATED on NULL auth.uid(); pgTAP adds NULL-auth.uid() cases; read-only post-check asserts no `…0099` in repointed bodies and zero availability rows with user_id=…0099. Verified the fallback exists at 01127 lines 267-276 and the DEV_IDENTITY USER_ID …0099 at orb-memory-bridge.ts:68.
