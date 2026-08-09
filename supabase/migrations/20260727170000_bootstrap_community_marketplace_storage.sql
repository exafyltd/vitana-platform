-- BOOTSTRAP-COMMUNITY-MARKETPLACE (Chunk 4): storage bucket for listing photos.
--
-- Chunk 1 (20260727090000) created the community_listings tables with an
-- `images TEXT[]` column expecting public URLs — it deliberately left the
-- actual image hosting unspecified. This adds a dedicated bucket rather than
-- reusing an unrelated one (diary-photos, avatars, ...): same owner-scoped
-- upload/delete convention as diary-photos (auth.uid() = first path segment,
-- i.e. objects are uploaded to `{user_id}/<filename>`), but with unrestricted
-- public SELECT like intent-covers, since listing photos must be visible to
-- every buyer browsing the marketplace, not just the seller.

BEGIN;

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'community-marketplace-listings',
  'community-marketplace-listings',
  TRUE,
  5242880, -- 5MB per photo, matching diary-photos
  ARRAY['image/jpeg', 'image/png', 'image/webp']
)
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "community-marketplace-listings public read" ON storage.objects;
CREATE POLICY "community-marketplace-listings public read" ON storage.objects
  FOR SELECT
  USING (bucket_id = 'community-marketplace-listings');

DROP POLICY IF EXISTS "community-marketplace-listings self insert" ON storage.objects;
CREATE POLICY "community-marketplace-listings self insert" ON storage.objects
  FOR INSERT
  WITH CHECK (bucket_id = 'community-marketplace-listings' AND auth.uid()::text = (storage.foldername(name))[1]);

DROP POLICY IF EXISTS "community-marketplace-listings self update" ON storage.objects;
CREATE POLICY "community-marketplace-listings self update" ON storage.objects
  FOR UPDATE
  USING (bucket_id = 'community-marketplace-listings' AND auth.uid()::text = (storage.foldername(name))[1])
  WITH CHECK (bucket_id = 'community-marketplace-listings' AND auth.uid()::text = (storage.foldername(name))[1]);

DROP POLICY IF EXISTS "community-marketplace-listings self delete" ON storage.objects;
CREATE POLICY "community-marketplace-listings self delete" ON storage.objects
  FOR DELETE
  USING (bucket_id = 'community-marketplace-listings' AND auth.uid()::text = (storage.foldername(name))[1]);

COMMIT;
