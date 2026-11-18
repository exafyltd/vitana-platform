-- fixture migration text (the storage schema does not replay on PGlite)
INSERT INTO storage.buckets (id, name, public) VALUES ('avatars', 'avatars', true) ON CONFLICT (id) DO NOTHING;
INSERT INTO storage.buckets (id, name, public) VALUES ('docs', 'docs', false);
CREATE POLICY "avatars_read" ON storage.objects FOR SELECT USING (bucket_id = 'avatars');
CREATE POLICY "docs_own" ON storage.objects FOR SELECT
  USING (bucket_id = 'docs' AND (storage.foldername(name))[1] = auth.uid()::text);
CREATE POLICY "docs_gone" ON storage.objects FOR DELETE USING (bucket_id = 'docs');
