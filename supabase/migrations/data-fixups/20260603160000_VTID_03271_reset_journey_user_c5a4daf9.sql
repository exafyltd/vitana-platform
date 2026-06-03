-- VTID-03271 data-fixup: reset ONE user's Journey Foundation so they can test
-- the GUIDED new-user flow from the gate. Deactivates the (junk "profil
-- vervollständigen") active goal so the Life Compass gate re-opens, and clears
-- the Journey Foundation cursor / economy stance / teacher-acks so journey_guide
-- leads from step 1. Scoped to a single user_id; safe + idempotent.
BEGIN;

UPDATE life_compass
   SET is_active = false, updated_at = now()
 WHERE user_id = 'c5a4daf9-190a-4a9e-9638-d6b32f85244a'
   AND is_active = true;

UPDATE user_journey_foundation
   SET journey_started_at   = NULL,
       current_next_step     = NULL,
       economic_intent       = NULL,
       focus_pillar          = NULL,
       completed_steps_cache = '{}',
       metadata              = '{}'::jsonb,
       updated_at            = now()
 WHERE user_id = 'c5a4daf9-190a-4a9e-9638-d6b32f85244a';

COMMIT;
