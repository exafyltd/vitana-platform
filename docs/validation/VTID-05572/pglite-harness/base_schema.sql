-- Stand-in for the pieces of the production schema the lane touches (local PGlite only; tenants carries both id and tenant_id like prod).
CREATE TABLE public.tenants (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid GENERATED ALWAYS AS (id) STORED UNIQUE, slug text UNIQUE NOT NULL, name text NOT NULL);
CREATE TABLE public.app_users (user_id uuid PRIMARY KEY, email text UNIQUE NOT NULL, display_name text);
CREATE TABLE public.user_tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.app_users(user_id) ON DELETE CASCADE, active_role text NOT NULL DEFAULT 'community',
  is_primary boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE (tenant_id, user_id));
CREATE TABLE public.profiles (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL UNIQUE, tenant_id uuid);
CREATE TABLE public.service_bot_accounts (user_id uuid PRIMARY KEY, label text NOT NULL, reason text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
