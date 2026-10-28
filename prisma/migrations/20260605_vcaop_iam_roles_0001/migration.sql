-- IAM-ROLES-0001 — Row-Level Security for VCAOP tables (runbook Sec. 5)
-- DB-level enforcement complementing the Gateway authz middleware (defense in depth).
--
-- Identity is read from request GUCs that Supabase already populates per request:
--   request.jwt.claim.sub          -> the user id (auth.uid())
--   request.jwt.claim.vcaop_role   -> the app role (community|staff|admin|developer)
-- (In Supabase, add `vcaop_role` to the JWT claims. Locally these GUCs are settable
--  with SET, which is how the rollback/RLS test exercises the policies.)
--
-- Role matrix:
--   community : own rows only in user-facing tables; no back-office access
--   staff     : back-office read/write; CANNOT approve human tasks (admin only)
--   admin     : everything, incl. policy edits and human-task approvals
--   developer : read-only on catalog (provider / affiliate_program)

CREATE OR REPLACE FUNCTION vcaop_uid() RETURNS text
  LANGUAGE sql STABLE AS $$ SELECT current_setting('request.jwt.claim.sub', true) $$;

CREATE OR REPLACE FUNCTION vcaop_role() RETURNS text
  LANGUAGE sql STABLE AS $$ SELECT current_setting('request.jwt.claim.vcaop_role', true) $$;

-- ---- Owner-scoped tables (community owns; staff/admin see all) ----------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['rewards_ledger','cart_order','user_reward_link'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($f$CREATE POLICY %1$s_owner_rw ON %1$I
        USING (vcaop_role() IN ('staff','admin') OR user_id = vcaop_uid())
        WITH CHECK (vcaop_role() IN ('staff','admin') OR user_id = vcaop_uid())$f$, t);
  END LOOP;
END $$;

-- merchant_route + disclosure: owner derived from parent cart_order.user_id
ALTER TABLE merchant_route ENABLE ROW LEVEL SECURITY;
ALTER TABLE merchant_route FORCE ROW LEVEL SECURITY;
CREATE POLICY merchant_route_owner_rw ON merchant_route
  USING (vcaop_role() IN ('staff','admin')
         OR EXISTS (SELECT 1 FROM cart_order c WHERE c.id = merchant_route.cart_order_id AND c.user_id = vcaop_uid()))
  WITH CHECK (vcaop_role() IN ('staff','admin')
         OR EXISTS (SELECT 1 FROM cart_order c WHERE c.id = merchant_route.cart_order_id AND c.user_id = vcaop_uid()));

ALTER TABLE disclosure ENABLE ROW LEVEL SECURITY;
ALTER TABLE disclosure FORCE ROW LEVEL SECURITY;
CREATE POLICY disclosure_owner_rw ON disclosure
  USING (vcaop_role() IN ('staff','admin')
         OR EXISTS (SELECT 1 FROM cart_order c WHERE c.id = disclosure.cart_order_id AND c.user_id = vcaop_uid()))
  WITH CHECK (vcaop_role() IN ('staff','admin')
         OR EXISTS (SELECT 1 FROM cart_order c WHERE c.id = disclosure.cart_order_id AND c.user_id = vcaop_uid()));

-- ---- Back-office tables (staff/admin only; community has no access) -----------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'business_identity','provider_account','provisioning_job','job_step',
    'job_attempt','job_artifact','account_health_snapshot','commission_event'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($f$CREATE POLICY %1$s_staff_rw ON %1$I
        USING (vcaop_role() IN ('staff','admin'))
        WITH CHECK (vcaop_role() IN ('staff','admin'))$f$, t);
  END LOOP;
END $$;

-- ---- Catalog tables: read staff/admin/developer; write admin only ------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['provider','affiliate_program'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($f$CREATE POLICY %1$s_read ON %1$I FOR SELECT
        USING (vcaop_role() IN ('staff','admin','developer'))$f$, t);
    EXECUTE format($f$CREATE POLICY %1$s_write ON %1$I FOR ALL
        USING (vcaop_role() = 'admin') WITH CHECK (vcaop_role() = 'admin')$f$, t);
  END LOOP;
END $$;

-- ---- human_task: staff/admin read+create; only admin may UPDATE (approve) -----
ALTER TABLE human_task ENABLE ROW LEVEL SECURITY;
ALTER TABLE human_task FORCE ROW LEVEL SECURITY;
CREATE POLICY human_task_read ON human_task FOR SELECT
  USING (vcaop_role() IN ('staff','admin'));
CREATE POLICY human_task_insert ON human_task FOR INSERT
  WITH CHECK (vcaop_role() IN ('staff','admin'));
CREATE POLICY human_task_update ON human_task FOR UPDATE
  USING (vcaop_role() = 'admin') WITH CHECK (vcaop_role() = 'admin');
