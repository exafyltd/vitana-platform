-- VTID-05445 tiny fixture schema for the generator and lint tests. Synthetic; applied on top of the stub auth schema.
CREATE FUNCTION public.current_tenant_id() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULL::uuid $$;
CREATE FUNCTION public.is_member(t uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
  AS $$ SELECT auth.uid() IS NOT NULL AND t IS NOT NULL $$;

-- clean: NOT NULL tenant_id, membership policy
CREATE TABLE public.good_t (id uuid PRIMARY KEY, tenant_id uuid NOT NULL, user_id uuid);
ALTER TABLE public.good_t ENABLE ROW LEVEL SECURITY;
CREATE POLICY good_t_sel ON public.good_t FOR SELECT USING (public.is_member(tenant_id));

-- lint 1: nullable tenant_id
CREATE TABLE public.nullable_t (id uuid PRIMARY KEY, tenant_id uuid);
ALTER TABLE public.nullable_t ENABLE ROW LEVEL SECURITY;
CREATE POLICY nullable_t_sel ON public.nullable_t FOR SELECT USING (public.is_member(tenant_id));

-- lint 2: no tenant policy (RLS on, no policy) and RLS off
CREATE TABLE public.no_policy_t (id uuid PRIMARY KEY, tenant_id uuid NOT NULL);
ALTER TABLE public.no_policy_t ENABLE ROW LEVEL SECURITY;
CREATE TABLE public.no_rls_t (id uuid PRIMARY KEY, tenant_id uuid NOT NULL);

-- bare policies (G3): one counted, one allowlisted, one that adds a user check
CREATE TABLE public.bare_t (id uuid PRIMARY KEY, tenant_id uuid NOT NULL);
ALTER TABLE public.bare_t ENABLE ROW LEVEL SECURITY;
CREATE POLICY bare_t_sel ON public.bare_t FOR SELECT USING (tenant_id = public.current_tenant_id());
CREATE TABLE public.bare_shared_t (id uuid PRIMARY KEY, tenant_id uuid NOT NULL);
ALTER TABLE public.bare_shared_t ENABLE ROW LEVEL SECURITY;
CREATE POLICY bare_shared_t_sel ON public.bare_shared_t FOR SELECT USING (tenant_id = public.current_tenant_id());
CREATE TABLE public.user_checked_t (id uuid PRIMARY KEY, tenant_id uuid NOT NULL, user_id uuid);
ALTER TABLE public.user_checked_t ENABLE ROW LEVEL SECURITY;
CREATE POLICY user_checked_t_sel ON public.user_checked_t FOR SELECT USING (tenant_id = public.current_tenant_id() AND user_id = auth.uid());

-- lint 4: realtime tables, one without tenant RLS, one with
CREATE TABLE public.rt_bad (id uuid PRIMARY KEY, tenant_id uuid NOT NULL);
CREATE TABLE public.rt_good (id uuid PRIMARY KEY, tenant_id uuid NOT NULL);
ALTER TABLE public.rt_good ENABLE ROW LEVEL SECURITY;
CREATE POLICY rt_good_sel ON public.rt_good FOR SELECT USING (public.is_member(tenant_id));
CREATE PUBLICATION supabase_realtime;
ALTER PUBLICATION supabase_realtime ADD TABLE public.rt_bad, public.rt_good;

-- health table present in the schema (the list of G4), no tenant policy on purpose
CREATE TABLE public.biomarker_results (id uuid PRIMARY KEY, tenant_id uuid NOT NULL, user_id uuid NOT NULL);

-- lint 3: SECURITY DEFINER functions
CREATE FUNCTION public.definer_open() RETURNS int LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$ SELECT 1 $$;
CREATE FUNCTION public.definer_revoked() RETURNS int LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$ SELECT 1 $$;
REVOKE ALL ON FUNCTION public.definer_revoked() FROM PUBLIC, anon, authenticated;
CREATE FUNCTION public.definer_checked() RETURNS uuid LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$ SELECT auth.uid() $$;
CREATE FUNCTION public.invoker_fn() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;
