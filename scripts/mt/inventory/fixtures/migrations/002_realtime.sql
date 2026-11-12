DROP POLICY IF EXISTS "docs_gone" ON storage.objects;
ALTER PUBLICATION supabase_realtime ADD TABLE public.rt_text_only;
ALTER PUBLICATION supabase_realtime ADD TABLE public.rt_bad;
