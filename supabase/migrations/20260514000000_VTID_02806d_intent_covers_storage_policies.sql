-- VTID-02806d — Storage RLS for the intent-covers bucket.
--
-- The bucket was created with public:true (read), but writes still
-- need explicit policies on storage.objects. Without these, an
-- authenticated user uploading their universal/library photo from
-- the browser hits "new row violates row-level security policy".
--
-- Path conventions used by CoverLibraryDrawer (vitana-v1):
--   user-universal/{userId}/{ts}.{ext}      — single per-user
--   user-library/{userId}/{photoId}.{ext}   — many per-user
-- AI/fallback writes done by the gateway use service role and
-- bypass these policies.

-- Public read — covers actually need to render anonymously on
-- match cards, so we keep this open. (Already implied by the
-- bucket's public:true, but make it explicit on the table.)
DROP POLICY IF EXISTS "intent-covers public read" ON storage.objects;
CREATE POLICY "intent-covers public read"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'intent-covers');

-- Self-write: allow an authenticated user to INSERT / UPDATE / DELETE
-- objects whose key starts with `user-universal/<their-uid>/...` or
-- `user-library/<their-uid>/...`. The folder check (storage.foldername)
-- splits the key by `/`; element [1] is the prefix, [2] is the user_id.
DROP POLICY IF EXISTS "intent-covers self insert" ON storage.objects;
CREATE POLICY "intent-covers self insert"
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'intent-covers'
    AND (storage.foldername(name))[1] IN ('user-universal', 'user-library')
    AND auth.uid()::text = (storage.foldername(name))[2]
  );

DROP POLICY IF EXISTS "intent-covers self update" ON storage.objects;
CREATE POLICY "intent-covers self update"
  ON storage.objects FOR UPDATE
  USING (
    bucket_id = 'intent-covers'
    AND (storage.foldername(name))[1] IN ('user-universal', 'user-library')
    AND auth.uid()::text = (storage.foldername(name))[2]
  )
  WITH CHECK (
    bucket_id = 'intent-covers'
    AND (storage.foldername(name))[1] IN ('user-universal', 'user-library')
    AND auth.uid()::text = (storage.foldername(name))[2]
  );

DROP POLICY IF EXISTS "intent-covers self delete" ON storage.objects;
CREATE POLICY "intent-covers self delete"
  ON storage.objects FOR DELETE
  USING (
    bucket_id = 'intent-covers'
    AND (storage.foldername(name))[1] IN ('user-universal', 'user-library')
    AND auth.uid()::text = (storage.foldername(name))[2]
  );
