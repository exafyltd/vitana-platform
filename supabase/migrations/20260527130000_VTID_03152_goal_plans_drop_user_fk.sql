-- VTID-03152 — Drop the goal_plans.user_id → app_users(user_id) foreign key.
--
-- Plan generation failed for real users who have a life_compass goal but no
-- app_users row: the LLM produced a valid plan, but the INSERT was rejected by
-- goal_plans_user_id_fkey ("violates foreign key constraint"). life_compass (the
-- goal source) does not gate on app_users, so requiring it here blocks valid
-- users. goal_plans is already scoped per-user by RLS (user_id = auth.uid()),
-- so the FK adds no protection the app relies on — drop it.

BEGIN;

ALTER TABLE public.goal_plans DROP CONSTRAINT IF EXISTS goal_plans_user_id_fkey;

COMMIT;
