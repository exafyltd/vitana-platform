-- VTID-05803 local test fixture: a small database shaped like Supabase `public` (run as a superuser on a scratch DB).
-- Covers every object kind the executor must carry or exclude. Contains member-like rows so tests can prove that no
-- data is copied.
CREATE ROLE anon NOLOGIN NOINHERIT;
CREATE ROLE authenticated NOLOGIN NOINHERIT;
CREATE ROLE service_role NOLOGIN NOINHERIT BYPASSRLS;
CREATE ROLE supabase_auth_admin NOLOGIN;
CREATE ROLE supabase_admin NOLOGIN;
CREATE ROLE src_reader LOGIN PASSWORD 'src-pass';

CREATE SCHEMA extensions;
CREATE EXTENSION "uuid-ossp" WITH SCHEMA extensions;
CREATE EXTENSION pgcrypto WITH SCHEMA extensions;
CREATE EXTENSION vector WITH SCHEMA public;

CREATE SCHEMA auth;
CREATE TABLE auth.users (id uuid PRIMARY KEY, email text, raw_user_meta_data jsonb);
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$ SELECT current_setting('request.jwt.claim.role', true) $$;
CREATE SCHEMA storage;
CREATE TABLE storage.buckets (id text PRIMARY KEY, name text);
CREATE TABLE storage.objects (id uuid PRIMARY KEY, bucket_id text REFERENCES storage.buckets(id), owner uuid);
CREATE SCHEMA supabase_functions;
CREATE FUNCTION supabase_functions.http_request() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;

-- types, sequences, tables, columns, defaults, generated and identity columns, constraints
CREATE TYPE public.member_mood AS ENUM ('ok', 'tired', 'great');
CREATE DOMAIN public.short_text AS text CHECK (length(VALUE) <= 80);
CREATE SEQUENCE public.ticket_no_seq START 1000 INCREMENT 5;
CREATE TABLE public.tenants (id uuid PRIMARY KEY DEFAULT extensions.uuid_generate_v4(), slug text NOT NULL UNIQUE, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.app_users (user_id uuid PRIMARY KEY, email text, tenant_id uuid REFERENCES public.tenants(id), created_at timestamptz DEFAULT now());
ALTER TABLE public.app_users ADD CONSTRAINT app_users_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
COMMENT ON CONSTRAINT app_users_user_id_fkey ON public.app_users IS 'to auth.users';
CREATE TABLE public.profiles (
  user_id uuid PRIMARY KEY REFERENCES public.app_users(user_id) ON DELETE CASCADE,
  display_name public.short_text,
  mood public.member_mood DEFAULT 'ok',
  embedding vector(3),
  tags text[] DEFAULT '{}',
  meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  ticket_no bigint DEFAULT nextval('public.ticket_no_seq'),
  name_lower text GENERATED ALWAYS AS (lower(display_name::text)) STORED,
  CHECK (ticket_no > 0)
);
COMMENT ON TABLE public.profiles IS 'member profiles';
COMMENT ON COLUMN public.profiles.mood IS 'self-reported';
CREATE TABLE public.memberships (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, user_id uuid NOT NULL REFERENCES public.app_users(user_id), tenant_id uuid NOT NULL REFERENCES public.tenants(id), role text NOT NULL DEFAULT 'member', UNIQUE (user_id, tenant_id));
CREATE TABLE public.posts (id bigserial PRIMARY KEY, author uuid NOT NULL DEFAULT auth.uid(), body text NOT NULL, created_at timestamptz DEFAULT now(), exclude_check int, EXCLUDE USING btree (exclude_check WITH =));
CREATE TABLE public.events (id bigserial, at timestamptz NOT NULL, kind text, PRIMARY KEY (id, at)) PARTITION BY RANGE (at);
CREATE TABLE public.events_2026 PARTITION OF public.events FOR VALUES FROM ('2026-01-01') TO ('2027-01-01');
CREATE TABLE public.service_bot_accounts (user_id uuid PRIMARY KEY);
CREATE TABLE public.notification_test_actors (user_id uuid PRIMARY KEY);
CREATE TABLE public.user_discount_codes (user_id uuid, code text);
CREATE TABLE public.storage_refs (id uuid PRIMARY KEY, object_id uuid REFERENCES storage.objects(id));

-- indexes
CREATE INDEX posts_author_created_idx ON public.posts (author, created_at DESC);
CREATE INDEX profiles_meta_gin ON public.profiles USING gin (meta);
CREATE INDEX profiles_embedding_hnsw ON public.profiles USING hnsw (embedding vector_cosine_ops);
CREATE UNIQUE INDEX profiles_name_lower_uq ON public.profiles (name_lower) WHERE name_lower IS NOT NULL;

-- views: public-only, over auth, over a bad view, matviews (good and bad) with indexes
CREATE VIEW public.post_counts AS SELECT author, count(*) AS n FROM public.posts GROUP BY author;
CREATE VIEW public.member_emails AS SELECT u.id, u.email FROM auth.users u;
CREATE VIEW public.member_emails_short AS SELECT id FROM public.member_emails;
COMMENT ON VIEW public.member_emails IS 'reads auth.users';
CREATE MATERIALIZED VIEW public.mv_member_count AS SELECT count(*) AS n FROM auth.users;
CREATE UNIQUE INDEX mv_member_count_uq ON public.mv_member_count (n);
CREATE MATERIALIZED VIEW public.mv_tenant_sizes AS SELECT tenant_id, count(*) AS n FROM public.memberships GROUP BY tenant_id;
CREATE UNIQUE INDEX mv_tenant_sizes_uq ON public.mv_tenant_sizes (tenant_id);
CREATE FUNCTION public.list_member_emails() RETURNS SETOF public.member_emails LANGUAGE sql STABLE AS $$ SELECT * FROM public.member_emails $$;

-- functions and procedures
CREATE FUNCTION public.touch_updated() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.created_at := now(); RETURN NEW; END $$;
CREATE FUNCTION public.my_tenant() RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$ SELECT tenant_id FROM public.app_users WHERE user_id = auth.uid() $$;
CREATE FUNCTION public.admin_stats(p_tenant uuid, p_days integer DEFAULT 7) RETURNS integer LANGUAGE plpgsql AS $$ BEGIN RETURN p_days; END $$;
CREATE PROCEDURE public.rebuild_counts() LANGUAGE sql AS $$ SELECT 1 $$;
-- functions the outbox file replaces (the source calls pg_net; the staging copy enqueues instead)
CREATE FUNCTION public.notify_welcome_discount() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM net.http_post('https://example.invalid'); RETURN NEW; END $$;
CREATE FUNCTION public.notify_test_user_confirmation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;
-- a function the auth bridge replaces with the same signature
CREATE FUNCTION public.erase_user_data(p_user_id uuid, p_dry_run boolean DEFAULT false) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN RETURN '{}'::jsonb; END $$;

-- triggers: public function (kept), Supabase webhook (excluded)
CREATE TRIGGER posts_touch BEFORE INSERT ON public.posts FOR EACH ROW EXECUTE FUNCTION public.touch_updated();
CREATE TRIGGER posts_webhook AFTER INSERT ON public.posts FOR EACH ROW EXECUTE FUNCTION supabase_functions.http_request();
CREATE TRIGGER user_discount_codes_welcome AFTER INSERT ON public.user_discount_codes FOR EACH ROW EXECUTE FUNCTION public.notify_welcome_discount();

-- RLS and policies (permissive, restrictive, FORCE, one over auth.users, one for a role Aurora lacks)
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.posts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.memberships FORCE ROW LEVEL SECURITY;
ALTER TABLE public.app_users ENABLE ROW LEVEL SECURITY;
CREATE POLICY profiles_self ON public.profiles FOR ALL TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
CREATE POLICY profiles_service ON public.profiles TO service_role USING (true);
CREATE POLICY posts_read ON public.posts FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY posts_write ON public.posts FOR INSERT TO authenticated WITH CHECK (author = auth.uid());
CREATE POLICY posts_tenant_guard ON public.posts AS RESTRICTIVE FOR ALL TO authenticated USING (auth.role() = 'authenticated');
CREATE POLICY memberships_self ON public.memberships FOR SELECT USING (user_id = auth.uid());
CREATE POLICY app_users_via_auth ON public.app_users FOR SELECT TO authenticated USING (EXISTS (SELECT 1 FROM auth.users u WHERE u.id = app_users.user_id));
CREATE POLICY app_users_auth_admin ON public.app_users FOR ALL TO supabase_auth_admin USING (true);
COMMENT ON POLICY app_users_via_auth ON public.app_users IS 'reads auth.users';

-- grants, the way Supabase leaves them
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
GRANT SELECT ON public.tenants, public.post_counts TO anon, authenticated;
GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
GRANT SELECT, INSERT, UPDATE ON public.profiles TO authenticated;
GRANT SELECT, INSERT ON public.posts TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.posts_id_seq TO authenticated;
GRANT SELECT ON public.memberships, public.mv_tenant_sizes TO authenticated;
REVOKE EXECUTE ON FUNCTION public.admin_stats(uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_stats(uuid, integer) TO service_role;
REVOKE EXECUTE ON PROCEDURE public.rebuild_counts() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.my_tenant() TO authenticated;
ALTER TABLE public.events OWNER TO supabase_admin;

-- member-like rows (must never reach staging)
INSERT INTO auth.users VALUES ('11111111-1111-1111-1111-111111111111', 'a@example.invalid', '{}'), ('22222222-2222-2222-2222-222222222222', 'b@example.invalid', '{}');
INSERT INTO public.tenants (id, slug) VALUES ('33333333-3333-3333-3333-333333333333', 'maxina');
INSERT INTO public.app_users (user_id, email, tenant_id) SELECT id, email, '33333333-3333-3333-3333-333333333333' FROM auth.users;
INSERT INTO public.profiles (user_id, display_name, embedding) VALUES ('11111111-1111-1111-1111-111111111111', 'Ana', '[1,2,3]');
INSERT INTO public.memberships (user_id, tenant_id) SELECT user_id, tenant_id FROM public.app_users;
INSERT INTO public.posts (author, body) VALUES ('11111111-1111-1111-1111-111111111111', 'hello');
INSERT INTO public.events (at, kind) VALUES ('2026-05-01', 'x');
REFRESH MATERIALIZED VIEW public.mv_tenant_sizes;

GRANT CONNECT ON DATABASE src TO src_reader;
GRANT USAGE ON SCHEMA public, auth, storage, extensions, supabase_functions TO src_reader;
GRANT SELECT ON ALL TABLES IN SCHEMA public, auth, storage TO src_reader;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO src_reader;
