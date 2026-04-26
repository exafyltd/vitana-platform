-- Vitana ID — Release B · hotfix for chat_messages backfill
-- VTID-01967
--
-- The original 20260428000000 backfill used a CTE+COALESCE+LOOP pattern
-- that produced an infinite loop on rows where the profiles lookup
-- returned NULL. The UPDATE counted as work (ROW_COUNT > 0) but the
-- value stayed NULL because COALESCE(NULL, NULL) = NULL, so the WHERE
-- clause kept matching the same rows.
--
-- Single-pass UPDATE using LEFT JOIN to profiles. Rows where the sender
-- or receiver has no profiles row stay NULL (correct — null-tolerant).

UPDATE public.chat_messages cm
   SET sender_vitana_id   = ps.vitana_id,
       receiver_vitana_id = pr.vitana_id
  FROM public.chat_messages cm2
  LEFT JOIN public.profiles ps ON ps.user_id = cm2.sender_id
  LEFT JOIN public.profiles pr ON pr.user_id = cm2.receiver_id
 WHERE cm.id = cm2.id
   AND (cm.sender_vitana_id IS NULL OR cm.receiver_vitana_id IS NULL)
   AND (ps.vitana_id IS NOT NULL OR pr.vitana_id IS NOT NULL);
