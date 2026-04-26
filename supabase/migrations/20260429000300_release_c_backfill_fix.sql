-- Vitana ID — Release C · backfill hotfix for user_notifications + user_activity_log stragglers
-- VTID-01969
--
-- The original Release C migrations used the same loop+nullable-subquery
-- pattern as the chat_messages migration that infinite-looped on rows
-- where the profiles lookup returned NULL. user_notifications never got
-- backfilled (the run was cancelled mid-loop). user_activity_log got most
-- rows but left 3 stragglers with no profile match. Single-pass JOIN now.

UPDATE public.user_notifications n
   SET recipient_vitana_id = p.vitana_id
  FROM public.profiles p
 WHERE n.user_id = p.user_id
   AND n.recipient_vitana_id IS NULL
   AND p.vitana_id IS NOT NULL;

UPDATE public.user_activity_log l
   SET actor_vitana_id = p.vitana_id
  FROM public.profiles p
 WHERE l.user_id = p.user_id
   AND l.actor_vitana_id IS NULL
   AND p.vitana_id IS NOT NULL;

UPDATE public.user_activity_log_archive l
   SET actor_vitana_id = p.vitana_id
  FROM public.profiles p
 WHERE l.user_id = p.user_id
   AND l.actor_vitana_id IS NULL
   AND p.vitana_id IS NOT NULL;
