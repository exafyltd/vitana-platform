-- VTID-05573 rollback of 20261102052200 (run SECOND, after rollback-052300). Removes exactly the rows the migration inserted
-- (chat_messages / chat_groups / chat_group_members marked metadata.legacy_source). REFUSES (changes nothing) if a migrated
-- group has received a message that is not a migrated one since: deleting the group would orphan it (group_id ON DELETE SET NULL
-- breaks the target XOR check), so that history must be moved first. Pre-existing platform rows are never touched.
BEGIN;
SET LOCAL lock_timeout = '10s';
DO $rb$
BEGIN
  IF EXISTS (SELECT 1 FROM public.chat_messages c
              WHERE c.group_id IN (SELECT g.id FROM public.chat_groups g WHERE g.metadata ->> 'legacy_source' IS NOT NULL)
                AND c.metadata ->> 'legacy_source' IS NULL) THEN
    RAISE EXCEPTION 'VTID-05573 rollback refused: a migrated group received new messages; move them first' USING ERRCODE = 'P0001';
  END IF;
END
$rb$;
DELETE FROM public.chat_messages WHERE metadata ->> 'legacy_source' IN ('messages', 'global_messages');
DELETE FROM public.chat_group_members WHERE group_id IN (SELECT id FROM public.chat_groups WHERE metadata ->> 'legacy_source' IS NOT NULL);
DELETE FROM public.chat_groups WHERE metadata ->> 'legacy_source' IN ('message_threads', 'global_message_threads');
COMMIT;
