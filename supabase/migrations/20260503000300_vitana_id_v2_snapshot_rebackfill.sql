-- Vitana ID v2 — denormalized snapshot re-backfill (VTID-01987)
-- After the re-mint, every denormalized vitana_id column carries the OLD
-- random-suffix value. The handle_aliases redirect catches URL-based
-- references, but for analytics, audit, and "all messages by @dragan1"-style
-- queries we want the snapshot columns aligned with the new IDs.
--
-- Single-pass UPDATE+JOIN per table — never a loop+nullable-subquery (that
-- bug bit Release B/C, fixed via the same JOIN pattern used here).
-- See [reference_migration_workflow.md] — apply this file individually via
-- RUN-MIGRATION.yml, off-peak, monitor disk IO.

-- chat_messages: sender + receiver
UPDATE public.chat_messages cm
   SET sender_vitana_id = p.vitana_id
  FROM public.profiles p
 WHERE cm.sender_id = p.user_id
   AND cm.sender_vitana_id IS DISTINCT FROM p.vitana_id;

UPDATE public.chat_messages cm
   SET receiver_vitana_id = p.vitana_id
  FROM public.profiles p
 WHERE cm.receiver_id = p.user_id
   AND cm.receiver_vitana_id IS DISTINCT FROM p.vitana_id;

-- oasis_events: user reference lives inside metadata->>'user_id' jsonb (not a
-- column). Retention pruning may have already deleted 7-day-old status='info'
-- rows; those are simply gone, no re-backfill needed.
UPDATE public.oasis_events oe
   SET vitana_id = p.vitana_id
  FROM public.profiles p
 WHERE oe.metadata ? 'user_id'
   AND (oe.metadata ->> 'user_id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
   AND p.user_id = (oe.metadata ->> 'user_id')::uuid
   AND oe.vitana_id IS DISTINCT FROM p.vitana_id;

-- user_notifications
UPDATE public.user_notifications n
   SET recipient_vitana_id = p.vitana_id
  FROM public.profiles p
 WHERE n.user_id = p.user_id
   AND n.recipient_vitana_id IS DISTINCT FROM p.vitana_id;

-- user_activity_log + archive
UPDATE public.user_activity_log l
   SET actor_vitana_id = p.vitana_id
  FROM public.profiles p
 WHERE l.user_id = p.user_id
   AND l.actor_vitana_id IS DISTINCT FROM p.vitana_id;

UPDATE public.user_activity_log_archive l
   SET actor_vitana_id = p.vitana_id
  FROM public.profiles p
 WHERE l.user_id = p.user_id
   AND l.actor_vitana_id IS DISTINCT FROM p.vitana_id;

-- autopilot_feedback
UPDATE public.autopilot_feedback f
   SET user_vitana_id = p.vitana_id
  FROM public.profiles p
 WHERE f.user_id = p.user_id
   AND f.user_vitana_id IS DISTINCT FROM p.vitana_id;

-- user_intents (Part 2 P2-A schema)
UPDATE public.user_intents ui
   SET requester_vitana_id = p.vitana_id
  FROM public.profiles p
 WHERE ui.requester_user_id = p.user_id
   AND ui.requester_vitana_id IS DISTINCT FROM p.vitana_id;

-- intent_matches: vitana_id_a + vitana_id_b denorm columns
UPDATE public.intent_matches im
   SET vitana_id_a = p.vitana_id
  FROM public.user_intents ui
  JOIN public.profiles p ON p.user_id = ui.requester_user_id
 WHERE im.intent_a_id = ui.intent_id
   AND im.vitana_id_a IS DISTINCT FROM p.vitana_id;

UPDATE public.intent_matches im
   SET vitana_id_b = p.vitana_id
  FROM public.user_intents ui
  JOIN public.profiles p ON p.user_id = ui.requester_user_id
 WHERE im.intent_b_id = ui.intent_id
   AND im.vitana_id_b IS DISTINCT FROM p.vitana_id;

-- intent_events: actor
UPDATE public.intent_events ie
   SET actor_vitana_id = p.vitana_id
  FROM public.profiles p
 WHERE ie.actor_user_id = p.user_id
   AND ie.actor_vitana_id IS DISTINCT FROM p.vitana_id;
