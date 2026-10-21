-- DOWN / rollback for IAM-ROLES-0001. Drops all VCAOP RLS policies, disables RLS,
-- and removes the helper functions. Verified up->down->up on ephemeral Postgres.
DROP POLICY IF EXISTS rewards_ledger_owner_rw ON rewards_ledger;
DROP POLICY IF EXISTS cart_order_owner_rw ON cart_order;
DROP POLICY IF EXISTS user_reward_link_owner_rw ON user_reward_link;
DROP POLICY IF EXISTS merchant_route_owner_rw ON merchant_route;
DROP POLICY IF EXISTS disclosure_owner_rw ON disclosure;
DROP POLICY IF EXISTS business_identity_staff_rw ON business_identity;
DROP POLICY IF EXISTS provider_account_staff_rw ON provider_account;
DROP POLICY IF EXISTS provisioning_job_staff_rw ON provisioning_job;
DROP POLICY IF EXISTS job_step_staff_rw ON job_step;
DROP POLICY IF EXISTS job_attempt_staff_rw ON job_attempt;
DROP POLICY IF EXISTS job_artifact_staff_rw ON job_artifact;
DROP POLICY IF EXISTS account_health_snapshot_staff_rw ON account_health_snapshot;
DROP POLICY IF EXISTS commission_event_staff_rw ON commission_event;
DROP POLICY IF EXISTS provider_read ON provider;
DROP POLICY IF EXISTS provider_write ON provider;
DROP POLICY IF EXISTS affiliate_program_read ON affiliate_program;
DROP POLICY IF EXISTS affiliate_program_write ON affiliate_program;
DROP POLICY IF EXISTS human_task_read ON human_task;
DROP POLICY IF EXISTS human_task_insert ON human_task;
DROP POLICY IF EXISTS human_task_update ON human_task;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'rewards_ledger','cart_order','user_reward_link','merchant_route','disclosure',
    'business_identity','provider_account','provisioning_job','job_step','job_attempt',
    'job_artifact','account_health_snapshot','commission_event','provider',
    'affiliate_program','human_task'
  ] LOOP
    EXECUTE format('ALTER TABLE %I DISABLE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;

DROP FUNCTION IF EXISTS vcaop_role();
DROP FUNCTION IF EXISTS vcaop_uid();
