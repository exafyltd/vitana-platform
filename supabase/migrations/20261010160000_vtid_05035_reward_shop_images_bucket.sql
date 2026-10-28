-- VTID-05035: storage bucket for Rewards shop item photos.
--
-- The admin screen (Admin › Marketplace › Rewards shop) uploads one photo per
-- item through the gateway (POST /api/v1/admin/rewards/items/image,
-- exafy_admin only, service role). The gateway checks type by magic bytes and
-- caps the decoded image at 1.4 MB; the bucket enforces the same cap and types.
--
-- Public bucket: members see the photos in the Shop, so objects are served
-- through the public URL. Deliberately NO storage.objects policy for anon or
-- authenticated: members never write to this bucket; only the gateway's
-- service role does.
--
-- Same insert-on-conflict convention as
-- 20260727170000_bootstrap_community_marketplace_storage.sql.

BEGIN;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'reward-shop-images',
  'reward-shop-images',
  true,
  1468006, -- 1.4 MB, same cap as the gateway route
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do nothing;

-- Self-check: fail the migration if the bucket is missing or not public.
do $$
begin
  if not exists (
    select 1 from storage.buckets where id = 'reward-shop-images' and public
  ) then
    raise exception 'VTID-05035: bucket reward-shop-images is missing or not public';
  end if;
end
$$;

COMMIT;
