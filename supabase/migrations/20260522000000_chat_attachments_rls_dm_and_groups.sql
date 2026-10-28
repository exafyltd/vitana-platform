-- impact-allow-solo-migration — pure-RLS fix, no gateway/worker code change needed
-- =============================================================================
-- Chat attachments: fix RLS SELECT policy so DM recipients and chat_groups
-- members can read images uploaded by other users.
--
-- Bug: uploads land at `{user_id}/{threadId}/{filename}` where `threadId` is
-- either the peer's user_id (DMs) or a chat_groups.id (new group chats).
-- The original policy only matched `threadId` against thread_participants /
-- global_thread_participants — so only the uploader could read the object,
-- and the recipient's createSignedUrl call failed → broken image in chat.
--
-- Note: `chat_group_members` is created by the platform repo migration
-- 20260525000000_VTID_03089_chat_groups.sql (same database). If that table
-- isn't present yet we install a policy that omits the chat_groups arm —
-- a follow-up migration will replace it once the table exists.
-- =============================================================================

DROP POLICY IF EXISTS "Users can view chat attachments" ON storage.objects;

DO $$
BEGIN
  IF to_regclass('public.chat_group_members') IS NOT NULL THEN
    EXECUTE $policy$
      CREATE POLICY "Users can view chat attachments" ON storage.objects
      FOR SELECT USING (
        bucket_id = 'chat-attachments' AND (
          -- Uploader can always read their own files
          auth.uid()::text = (storage.foldername(name))[1]
          OR
          -- DM recipient: path is {sender_id}/{recipient_id}/{file}; auth user is
          -- the recipient AND there's a chat_messages row from the sender to them.
          (
            auth.uid()::text = (storage.foldername(name))[2]
            AND EXISTS (
              SELECT 1 FROM public.chat_messages cm
              WHERE cm.receiver_id = auth.uid()
                AND cm.sender_id::text = (storage.foldername(name))[1]
            )
          )
          OR
          -- chat_groups member: path is {sender_id}/{group_id}/{file}; auth user
          -- belongs to that group.
          EXISTS (
            SELECT 1 FROM public.chat_group_members m
            WHERE m.user_id = auth.uid()
              AND m.group_id::text = (storage.foldername(name))[2]
          )
          OR
          -- Legacy: per-thread participants (1:1 thread_participants table)
          EXISTS (
            SELECT 1 FROM public.thread_participants tp
            WHERE tp.user_id = auth.uid()
              AND tp.thread_id::text = (storage.foldername(name))[2]
              AND tp.is_active = true
          )
          OR
          -- Legacy: global thread participants (community group_message_threads)
          EXISTS (
            SELECT 1 FROM public.global_thread_participants gtp
            WHERE gtp.user_id = auth.uid()
              AND gtp.thread_id::text = (storage.foldername(name))[2]
              AND gtp.is_active = true
          )
        )
      )
    $policy$;
  ELSE
    EXECUTE $policy$
      CREATE POLICY "Users can view chat attachments" ON storage.objects
      FOR SELECT USING (
        bucket_id = 'chat-attachments' AND (
          auth.uid()::text = (storage.foldername(name))[1]
          OR
          (
            auth.uid()::text = (storage.foldername(name))[2]
            AND EXISTS (
              SELECT 1 FROM public.chat_messages cm
              WHERE cm.receiver_id = auth.uid()
                AND cm.sender_id::text = (storage.foldername(name))[1]
            )
          )
          OR
          EXISTS (
            SELECT 1 FROM public.thread_participants tp
            WHERE tp.user_id = auth.uid()
              AND tp.thread_id::text = (storage.foldername(name))[2]
              AND tp.is_active = true
          )
          OR
          EXISTS (
            SELECT 1 FROM public.global_thread_participants gtp
            WHERE gtp.user_id = auth.uid()
              AND gtp.thread_id::text = (storage.foldername(name))[2]
              AND gtp.is_active = true
          )
        )
      )
    $policy$;
  END IF;
END$$;
