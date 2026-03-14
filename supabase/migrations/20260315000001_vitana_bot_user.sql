-- =============================================================================
-- Vitana Bot User — system user for Vitana DM conversations
-- =============================================================================
--
-- Creates a well-known system user for Vitana so voice transcripts and text
-- replies appear as a direct chat in the DM list. The fixed UUID is
-- deterministic and cannot collide with real v4 UUIDs.
--
-- Tables populated:
--   auth.users             — required by FK constraint app_users_user_id_fkey
--   app_users              — core user record (local migration-managed)
--   global_community_profiles — display_name + avatar (Lovable-managed)
--   profiles               — full_name + avatar (Lovable-managed)
-- =============================================================================

-- 0. Create auth.users record (app_users.user_id references auth.users.id)
INSERT INTO auth.users (
  id,
  instance_id,
  aud,
  role,
  email,
  encrypted_password,
  email_confirmed_at,
  created_at,
  updated_at,
  is_sso_user,
  raw_app_meta_data,
  raw_user_meta_data
) VALUES (
  '00000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000000',
  'authenticated',
  'authenticated',
  'vitana@vitana.app',
  '',
  NOW(),
  NOW(),
  NOW(),
  false,
  '{"provider": "system", "is_bot": true}'::jsonb,
  '{"display_name": "Vitana", "is_bot": true}'::jsonb
)
ON CONFLICT (id) DO NOTHING;

-- 1-3. App user + profile records
DO $$
DECLARE
  v_vitana_id UUID := '00000000-0000-0000-0000-000000000001';
  v_default_tenant UUID;
BEGIN
  -- Get the default tenant (app_users.tenant_id is NOT NULL)
  SELECT tenant_id INTO v_default_tenant
  FROM tenants ORDER BY created_at ASC LIMIT 1;

  -- 1. Core user record in app_users
  INSERT INTO app_users (user_id, email, display_name, tenant_id, created_at, updated_at)
  VALUES (v_vitana_id, 'vitana@vitana.app', 'Vitana', v_default_tenant, NOW(), NOW())
  ON CONFLICT (user_id) DO NOTHING;

  -- 2. Global community profile (for frontend enrichProfiles lookup)
  --    Table is Lovable-managed; safe upsert by user_id
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'global_community_profiles' AND table_schema = 'public') THEN
    INSERT INTO global_community_profiles (user_id, display_name, avatar_url)
    VALUES (v_vitana_id, 'Vitana', '/vitana-avatar.png')
    ON CONFLICT (user_id) DO UPDATE SET
      display_name = EXCLUDED.display_name,
      avatar_url = EXCLUDED.avatar_url;
  END IF;

  -- 3. Profiles table (fallback enrichment path)
  --    Table is Lovable-managed; PK is "id" not "user_id"
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'profiles' AND table_schema = 'public') THEN
    INSERT INTO profiles (id, full_name, avatar_url)
    VALUES (v_vitana_id, 'Vitana', '/vitana-avatar.png')
    ON CONFLICT (id) DO UPDATE SET
      full_name = EXCLUDED.full_name,
      avatar_url = EXCLUDED.avatar_url;
  END IF;
END $$;
