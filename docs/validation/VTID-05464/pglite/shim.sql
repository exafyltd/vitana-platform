-- Minimal pgTAP shim for PGlite (VTID-05464). Records each assertion; never raises on a failed assertion,
-- so the plan runs to the end the way pg_prove reports it. Only the functions the VTID-05464 plan calls.
CREATE TABLE IF NOT EXISTS public.__tap (n serial PRIMARY KEY, ok boolean NOT NULL, line text NOT NULL);
CREATE TABLE IF NOT EXISTS public.__tap_plan (id int PRIMARY KEY, planned int);
GRANT ALL ON public.__tap, public.__tap_plan TO PUBLIC;
GRANT USAGE, SELECT, UPDATE ON SEQUENCE public.__tap_n_seq TO PUBLIC;

CREATE OR REPLACE FUNCTION public.plan(p int) RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM public.__tap;
  INSERT INTO public.__tap_plan(id, planned) VALUES (1, p)
    ON CONFLICT (id) DO UPDATE SET planned = excluded.planned;
  RETURN '1..' || p;
END $$;

CREATE OR REPLACE FUNCTION public.__rec(b boolean, d text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE k boolean := coalesce(b, false); l text; nn int;
BEGIN
  SELECT count(*) + 1 INTO nn FROM public.__tap;
  l := (CASE WHEN k THEN 'ok ' ELSE 'not ok ' END) || nn || ' - ' || coalesce(d, '');
  INSERT INTO public.__tap(ok, line) VALUES (k, l);
  RETURN l;
END $$;

CREATE OR REPLACE FUNCTION public.ok(b boolean, d text) RETURNS text LANGUAGE sql AS 'SELECT public.__rec($1, $2)';

CREATE OR REPLACE FUNCTION public.is(a anyelement, b anyelement, d text) RETURNS text LANGUAGE sql AS
  'SELECT public.__rec(($1 IS NOT DISTINCT FROM $2), $3)';

CREATE OR REPLACE FUNCTION public.throws_ok(q text, code text, msg text, d text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE st text := 'none'; k boolean := false;
BEGIN
  BEGIN
    EXECUTE q;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS st = RETURNED_SQLSTATE;
    k := (code IS NULL OR st = code);
  END;
  RETURN public.__rec(k, d);
END $$;

CREATE OR REPLACE FUNCTION public.results_eq(q1 text, q2 text, d text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE a text[]; b text[];
BEGIN
  EXECUTE format('SELECT coalesce(array_agg(t::text ORDER BY t::text), ''{}''::text[]) FROM (%s) t', q1) INTO a;
  EXECUTE format('SELECT coalesce(array_agg(t::text ORDER BY t::text), ''{}''::text[]) FROM (%s) t', q2) INTO b;
  RETURN public.__rec(a IS NOT DISTINCT FROM b, d);
END $$;

CREATE OR REPLACE FUNCTION public.has_function(sch text, nm text, args text[], d text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  RETURN public.__rec(EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = sch AND p.proname = nm
       AND (SELECT coalesce(string_agg(format_type(t, NULL), ', ' ORDER BY ord), '')
              FROM unnest(p.proargtypes) WITH ORDINALITY AS u(t, ord)) = array_to_string(args, ', ')), d);
END $$;

CREATE OR REPLACE FUNCTION public.function_returns(sch text, nm text, args text[], rt text, d text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  RETURN public.__rec(EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = sch AND p.proname = nm
       AND (SELECT coalesce(string_agg(format_type(t, NULL), ', ' ORDER BY ord), '')
              FROM unnest(p.proargtypes) WITH ORDINALITY AS u(t, ord)) = array_to_string(args, ', ')
       AND format_type(p.prorettype, NULL) = rt), d);
END $$;

CREATE OR REPLACE FUNCTION public.finish() RETURNS SETOF text LANGUAGE sql AS
  'SELECT line FROM public.__tap ORDER BY n';
