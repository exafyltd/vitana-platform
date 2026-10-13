# Lane C — public tenant registry contract (VTID-05151)

The frontend (vitana-v1) reads tenants from two public read functions, never from `tenants` or
`tenant_settings` directly before sign-in:

- `public.list_public_tenants()` — every active, slugged, non-platform tenant, ordered by slug.
- `public.resolve_tenant(p_slug text)` — the same row for `slug = lower(btrim(p_slug))`, or none.

Both are `STABLE SECURITY DEFINER`, granted to `anon, authenticated, service_role`, and served by
PostgREST over GET (`/rest/v1/rpc/list_public_tenants`). They return exactly:

| Column | Type | Source |
|---|---|---|
| `tenant_id` | uuid | `tenants.tenant_id` |
| `slug` | text | `tenants.slug` |
| `name` | text | `tenants.name` |
| `display_name` | text | `brand.display_name`, else `tenants.name` |
| `open_signup` | boolean | `tenants.open_signup` (VTID-05043) |
| `brand` | jsonb | whitelist `accent, bg, fg, logo_path, favicon_path, og_image_path` |
| `landing` | jsonb | whitelist `tagline` (locale → text), `intro`, `auto_switch_on_visit`, `post_login_path`, `oauth` |
| `locales` | jsonb | array, or NULL = every platform GA locale |

## What lane B writes, so lane C reads it without a new migration

- `tenant_settings.brand jsonb` — `{"tokens":{"accent","bg","fg"}, "assets":{"logo","favicon","og_image"}, "display_name"}`.
  Merged over the legacy `tenants.branding` / `tenant_settings.branding` keys
  (`brand_accent`, `brand_bg`, `brand_fg`, `*_path`, `display_name`); `brand` wins.
- `tenant_settings.landing jsonb` — the landing keys above; merged over `tenant_settings.profile.landing`.
- `tenant_settings.locales jsonb` — a JSON array of locale codes; wins over `profile.locales`.
- `tenants.is_platform boolean NOT NULL DEFAULT false` (lane A) — a platform row is never listed.

Asset paths are relative paths in the public `tenant-assets` bucket (`<slug>/…`); the frontend
rejects an absolute URL. Colours are `#rrggbb`; the frontend drops anything else.

A different column or key name means extending the whitelist in a new migration; the local
harness (`scripts/ci/test-vtid-05151-public-tenant-registry.sh`, case (e)) fails until it does.

## Reserved slugs

vitana-v1 publishes `/reserved-tenant-slugs.json` (every top-level SPA route, `public/` entry and
platform prefix, minus the legacy tenant routes `maxina`/`alkalma`). Lane B's `provision_tenant`
slug check consumes it (program §4.8).
