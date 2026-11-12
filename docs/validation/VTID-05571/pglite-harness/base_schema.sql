-- Stand-in for the pieces of the production schema the lane touches (local PGlite only; tenants carries both id and tenant_id like prod).
CREATE TABLE public.tenants (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid GENERATED ALWAYS AS (id) STORED UNIQUE, slug text UNIQUE NOT NULL, name text NOT NULL);
CREATE TABLE public.app_users (user_id uuid PRIMARY KEY, email text UNIQUE NOT NULL, display_name text);
CREATE TABLE public.user_tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.app_users(user_id) ON DELETE CASCADE, active_role text NOT NULL DEFAULT 'community',
  is_primary boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE (tenant_id, user_id));
CREATE TABLE public.profiles (id uuid PRIMARY KEY, tenant_id uuid);
CREATE TABLE public.memory_facts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, user_id uuid NOT NULL, thread_id uuid,
  entity text NOT NULL DEFAULT 'self', fact_key text NOT NULL, fact_value text NOT NULL, fact_value_type text NOT NULL DEFAULT 'text',
  provenance_source text NOT NULL DEFAULT 'user_stated', provenance_utterance_id uuid, provenance_confidence numeric(3,2) NOT NULL DEFAULT 0.90,
  superseded_by uuid REFERENCES public.memory_facts(id), superseded_at timestamptz, extracted_at timestamptz NOT NULL DEFAULT now(), vtid text DEFAULT 'VTID-01192');
CREATE TABLE public.memory_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, user_id uuid NOT NULL, active_role text, category_key text NOT NULL,
  source text NOT NULL, content text NOT NULL CHECK (content != ''), content_json jsonb, importance int NOT NULL DEFAULT 10,
  occurred_at timestamptz NOT NULL DEFAULT now(), created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.chat_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, sender_id uuid NOT NULL, receiver_id uuid,
  group_id uuid, content text NOT NULL, read_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
  -- Matches production (20260525000000_VTID_03089_chat_groups.sql:40-51): a DM has receiver_id, a group message has group_id and receiver_id NULL.
  CONSTRAINT chat_messages_dm_xor_group CHECK ((receiver_id IS NOT NULL AND group_id IS NULL) OR (receiver_id IS NULL AND group_id IS NOT NULL)));
CREATE TABLE public.user_notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, tenant_id uuid NOT NULL, type text NOT NULL, title text NOT NULL,
  body text, data jsonb DEFAULT '{}', read_at timestamptz, created_at timestamptz NOT NULL DEFAULT now());
