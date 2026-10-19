# Sparring round 1 — in_progress

Session: `2efa877e-46e8-4355-a2e0-d9b3c30be794` · plan hash `186d41c7bbb8c6b11e21c45d5aa79a0a075308952688e6881d7b7884d54350cb`

## Summary

The plan's identity premises hold cleanly and all five confirmed NULL-fallback writers carry the exact pattern described. Three blockers found: (1) both `user_notifications.tenant_id` and `product_analytics_events.tenant_id` are already `NOT NULL` in their authoritative DDL migrations — DATABASE_SCHEMA.md omits nullability markers creating a false premise that drives the entire Lane 4 scope; with all named hot tables already NOT NULL, Lane 4 has no valid targets; (2) two migrations in the same d-series (`01142` d48-opportunity-surfacing and `01143` d49-risk-mitigation) are absent from the plan's five-function repointing list despite sitting in the same directory, same date range, and presumably the same pattern — leaving them unaddressed guarantees re-pollution of the zero-orphan post-check. One major: the Lane 1 post-check verifies column existence but never call-tests the repointed writers, leaving a degenerate-membership failure mode undetected in staging.

## Findings

### R1-F1 [blocker]

`product_analytics_events.tenant_id` is already `NOT NULL`. The plan asserts it is nullable at `DATABASE_SCHEMA.md:2540` and proposes Lane 4 apply an INSERT trigger + CHECK→VALIDATE→SET NOT NULL sequence. The DATABASE_SCHEMA.md prose writes `tenant_id UUID` without a nullability marker — documentation formatting only. The authoritative DDL in the bootstrap migration defines `tenant_id uuid not null` on line 33. Lane 4's batched backfill would find zero residual NULLs, the SET NOT NULL would be redundant, and the BEFORE INSERT trigger adds permanent overhead for a column already fully constrained.

- `exafyltd/vitana-platform:supabase/migrations/20260612140000_BOOTSTRAP_product_analytics_events.sql:18` — create table if not exists public.product_analytics_events (
  id uuid primary key default gen_random_uuid(),
  event_id text not null unique,
  event_name text not null,
  event_type text not null check (
    event_type in (
      'journey',
      'assistant',
      'feature',
      'interest',
      'friction',
      'performance',
      'content'
    )
  ),
  tenant_id uuid not null,
  user_id_hash text,
- `exafyltd/vitana-platform:DATABASE_SCHEMA.md:2538` — ```
product_analytics_events (
  id UUID PK, event_id TEXT UNIQUE,  -- client-generated, idempotency key
  event_name TEXT, event_type TEXT,  -- journey|assistant|feature|interest|friction|performance|content
  tenant_id UUID, user_id_hash TEXT, -- SHA-256 of user id; never the raw id

Suggestion: Remove `product_analytics_events` from Lane 4 entirely. The column is already NOT NULL; there are no NULL residuals and no constraint to add. Fix `DATABASE_SCHEMA.md:2542` to record `tenant_id UUID NOT NULL` to prevent this false premise recurring. Any `tenant_id = '…0001'` rows are handled by Lane 1 remap/quarantine only.

### R1-F2 [blocker]

`user_notifications.tenant_id` is already `NOT NULL`. The plan calls it 'the real nullable hot table needing §4.7 expand/contract' and 'nullable per line 109', but the DDL in the original notification-system migration defines `tenant_id UUID NOT NULL`. The nine orphan `user_notifications` rows under `…0001` carry `tenant_id = '00000000-0000-0000-0000-000000000001'` (wrong-but-non-NULL), already handled by Lane 1 remap/quarantine — not by a NOT NULL hardening pass. With `chat_messages`, `user_notifications`, and `product_analytics_events` all already NOT NULL, Lane 4's pre-check will find zero nullable columns and the entire lane is a no-op. The BEFORE INSERT trigger, the trigger-naming/ordering machinery, and the expand/contract sequence are all work against a non-existent problem.

- `exafyltd/vitana-platform:supabase/migrations/20260225000000_notification_system.sql:24` — CREATE TABLE IF NOT EXISTS user_notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  tenant_id UUID NOT NULL,
  type TEXT NOT NULL,        -- e.g. 'live_room_starting', 'new_match', 'task_completed'
  title TEXT NOT NULL,
  body TEXT,
  data JSONB DEFAULT '{}',   -- deep-link URL, entity IDs, etc.
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
- `exafyltd/vitana-platform:supabase/migrations/20260225200000_notification_db_triggers.sql:49` — INSERT INTO user_notifications (user_id, tenant_id, type, title, body, data, channel, priority)
    VALUES (
      NEW.user_id,
      NEW.tenant_id,
      v_type,
      v_title,
      v_body,
      jsonb_build_object('entity_id', NEW.id::text, 'signal_type', NEW.signal_type, 'confidence', NEW.confidence),
      CASE WHEN v_priority = 'p0' THEN 'push_and_inapp' ELSE 'inapp' END,
      v_priority
    );

Suggestion: Remove `user_notifications` from Lane 4 scope. Run the planned `information_schema.columns` pre-check now (before plan approval, not deferred to implementation) to confirm no named hot-table columns are actually nullable. If all three named tables are confirmed NOT NULL, Lane 4 has no targets and should be collapsed into Lane 1 or dropped. Update the program plan's 'WS2 line 109' reference.

### R1-F3 [blocker]

Two migrations in the same d-series are absent from the plan's five-function repointing list: `20260103_vtid_01142_d48_opportunity_surfacing.sql` and `20260103_vtid_01143_d49_risk_mitigation.sql` (visible in `database/migrations` via list_dir). Every confirmed migration in this series — 01137→d43, 01138→d44, 01139→d45, 01144→d50 — follows the identical pattern: look up `raw_user_meta_data->>'tenant_id'` from `auth.users`, then fall back to `'00000000-0000-0000-0000-000000000001'::uuid`. The pattern is 100% consistent across all four read files. If 01142 and 01143 carry the same fallback (near-certain given the complete consistency), leaving them unrepointed means those two functions continue writing `tenant_id = '…0001'` on every call by a user whose JWT metadata lacks `tenant_id`, re-polluting tables and invalidating the zero-orphan post-check.

- `exafyltd/vitana-platform:database/migrations/20260103_vtid_01139_d45_predictive_risk_forecasting.sql:217` —     SELECT raw_user_meta_data->>'tenant_id'
    INTO v_tenant_id
    FROM auth.users
    WHERE id = v_user_id;

    IF v_tenant_id IS NULL THEN
        v_tenant_id := '00000000-0000-0000-0000-000000000001'::uuid;
    END IF;
- `exafyltd/vitana-platform:database/migrations/20260102_vtid_01137_d43_longitudinal_adaptation.sql:262` —     SELECT raw_user_meta_data->>'tenant_id'
    INTO v_tenant_id
    FROM auth.users
    WHERE id = v_user_id;

    IF v_tenant_id IS NULL THEN
        v_tenant_id := '00000000-0000-0000-0000-000000000001'::uuid;
    END IF;
- `exafyltd/vitana-platform:database/migrations/20260103_vtid_01138_d44_signal_detection.sql:217` —     -- Get tenant from user metadata or default
    SELECT raw_user_meta_data->>'tenant_id'
    INTO v_tenant_id
    FROM auth.users
    WHERE id = v_user_id;

    IF v_tenant_id IS NULL THEN
        v_tenant_id := '00000000-0000-0000-0000-000000000001'::uuid;
    END IF;
- `exafyltd/vitana-platform:database/migrations/20260103_vtid_01144_positive_trajectory_reinforcement.sql:186` —     -- Get tenant from user metadata or default
    SELECT raw_user_meta_data->>'tenant_id'
    INTO v_tenant_id
    FROM auth.users
    WHERE id = v_user_id;

    IF v_tenant_id IS NULL THEN
        v_tenant_id := '00000000-0000-0000-0000-000000000001'::uuid;
    END IF;

Suggestion: Before plan approval, read `20260103_vtid_01142_d48_opportunity_surfacing.sql` and `20260103_vtid_01143_d49_risk_mitigation.sql`. If they contain the same NULL-fallback (expected), add them to the repointing list, add d48 and d49 to the `analyze_orphan_rows()` baseline enumeration, and include them in the zero-orphan post-check. Correct 'five NULL-fallback writer functions' to seven (or the confirmed count). The pgTAP repointing test must cover all confirmed functions.

### R1-F4 [major]

The Lane 1 post-check verifies that `user_tenants.is_primary` column exists but never call-tests the repointed writer functions end-to-end. PostgreSQL compiles PL/pgSQL bodies without validating column references, so `CREATE OR REPLACE FUNCTION` for the repointed writers succeeds even if `user_tenants` has zero primary rows. A degenerate state — column present, zero primary rows for real members (possible if `membership-unification` ran the DDL migration but not the data backfill) — causes every repointed writer to RAISE on the first real call. That failure is silent during the Lane 1 post-check (which counts orphan rows, not writer invocations) and surfaces in production as broken member-facing boundary/consent/analytics operations.

- `exafyltd/vitana-platform:database/migrations/20260102_vtid_01135_boundary_consent.sql:345` —     v_user_id := auth.uid();
    IF v_user_id IS NULL THEN
        v_user_id := current_setting('request.jwt.claims', true)::jsonb->>'sub';
    END IF;

    IF v_user_id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'UNAUTHENTICATED');
    END IF;

    -- Get tenant
    SELECT tenant_id INTO v_tenant_id FROM profiles WHERE id = v_user_id LIMIT 1;
    IF v_tenant_id IS NULL THEN
        v_tenant_id := '00000000-0000-0000-0000-000000000001'::UUID; -- Default tenant
    END IF;
- `exafyltd/vitana-platform:database/migrations/20260103_vtid_01144_positive_trajectory_reinforcement.sql:186` —     SELECT raw_user_meta_data->>'tenant_id'
    INTO v_tenant_id
    FROM auth.users
    WHERE id = v_user_id;

    IF v_tenant_id IS NULL THEN
        v_tenant_id := '00000000-0000-0000-0000-000000000001'::uuid;
    END IF;

Suggestion: Add a call-test to the Lane 1 post-check SQL: invoke each repointed function in a read-only transaction with a known member UUID that has exactly one `user_tenants` row with `is_primary = true` and assert it returns `ok: true` without raising. Also add a negative call-test with a UUID that has zero primary rows and assert it raises rather than writing `…0001`. This proves both the lookup path and the raise-on-ambiguity path are live before Lane 1 is declared complete.

## Next

Planner: answer every finding above in `sparring/responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
