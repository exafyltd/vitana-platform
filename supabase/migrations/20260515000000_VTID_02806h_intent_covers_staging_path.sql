-- VTID-02806h — Allow authenticated users to upload to a `staging/`
-- prefix in the intent-covers bucket so the cover-image processor
-- (Imagen outpaint) can read the source. The gateway processes the
-- staged file with service-role and writes the final 16:9 result
-- to user-universal/ or user-library/ before deleting the staged
-- copy.
--
-- We DROP and re-create the existing self-write policies to extend
-- the prefix list with `staging`. The previous policies allowed
-- only `user-universal` and `user-library`.

DROP POLICY IF EXISTS "intent-covers self insert" ON storage.objects;
CREATE POLICY "intent-covers self insert"
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'intent-covers'
    AND (storage.foldername(name))[1] IN ('user-universal', 'user-library', 'staging')
    AND auth.uid()::text = (storage.foldername(name))[2]
  );

DROP POLICY IF EXISTS "intent-covers self update" ON storage.objects;
CREATE POLICY "intent-covers self update"
  ON storage.objects FOR UPDATE
  USING (
    bucket_id = 'intent-covers'
    AND (storage.foldername(name))[1] IN ('user-universal', 'user-library', 'staging')
    AND auth.uid()::text = (storage.foldername(name))[2]
  )
  WITH CHECK (
    bucket_id = 'intent-covers'
    AND (storage.foldername(name))[1] IN ('user-universal', 'user-library', 'staging')
    AND auth.uid()::text = (storage.foldername(name))[2]
  );

DROP POLICY IF EXISTS "intent-covers self delete" ON storage.objects;
CREATE POLICY "intent-covers self delete"
  ON storage.objects FOR DELETE
  USING (
    bucket_id = 'intent-covers'
    AND (storage.foldername(name))[1] IN ('user-universal', 'user-library', 'staging')
    AND auth.uid()::text = (storage.foldername(name))[2]
  );
