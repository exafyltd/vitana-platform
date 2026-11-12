-- Minimal pgTAP-compatible shim for PGlite (local evidence harness, copied from VTID-05571).
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE TABLE IF NOT EXISTS extensions._tap (id int PRIMARY KEY DEFAULT 1, n int NOT NULL DEFAULT 0, failed int NOT NULL DEFAULT 0, planned int);
INSERT INTO extensions._tap (id) VALUES (1) ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION extensions.plan(p int) RETURNS text LANGUAGE plpgsql AS $$
BEGIN UPDATE extensions._tap SET n = 0, failed = 0, planned = p; RETURN '1..' || p; END $$;

CREATE OR REPLACE FUNCTION extensions.ok(p_ok boolean, p_desc text DEFAULT '') RETURNS text LANGUAGE plpgsql AS $$
DECLARE v int;
BEGIN
  UPDATE extensions._tap SET n = n + 1, failed = failed + CASE WHEN coalesce(p_ok, false) THEN 0 ELSE 1 END RETURNING n INTO v;
  RETURN CASE WHEN coalesce(p_ok, false) THEN 'ok ' ELSE 'not ok ' END || v || ' - ' || coalesce(p_desc, '');
END $$;

CREATE OR REPLACE FUNCTION extensions.is(a anyelement, b anyelement, p_desc text DEFAULT '') RETURNS text LANGUAGE plpgsql AS $$
DECLARE r text;
BEGIN
  r := extensions.ok(a IS NOT DISTINCT FROM b, p_desc);
  IF a IS DISTINCT FROM b THEN r := r || E'\n#   have: ' || coalesce(a::text, 'NULL') || E'\n#   want: ' || coalesce(b::text, 'NULL'); END IF;
  RETURN r;
END $$;

CREATE OR REPLACE FUNCTION extensions.isnt(a anyelement, b anyelement, p_desc text DEFAULT '') RETURNS text LANGUAGE sql AS
$$ SELECT extensions.ok(a IS DISTINCT FROM b, p_desc) $$;

CREATE OR REPLACE FUNCTION extensions.matches(a text, re text, p_desc text DEFAULT '') RETURNS text LANGUAGE sql AS
$$ SELECT extensions.ok(a ~ re, p_desc) $$;

CREATE OR REPLACE FUNCTION extensions.doesnt_match(a text, re text, p_desc text DEFAULT '') RETURNS text LANGUAGE sql AS
$$ SELECT extensions.ok(a !~ re, p_desc) $$;

CREATE OR REPLACE FUNCTION extensions.lives_ok(p_sql text, p_desc text DEFAULT '') RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  BEGIN EXECUTE p_sql; EXCEPTION WHEN OTHERS THEN
    RETURN extensions.ok(false, p_desc) || E'\n#   died: ' || SQLSTATE || ' ' || SQLERRM;
  END;
  RETURN extensions.ok(true, p_desc);
END $$;

CREATE OR REPLACE FUNCTION extensions.throws_ok(p_sql text, p_errcode text, p_errmsg text, p_desc text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  BEGIN EXECUTE p_sql; EXCEPTION WHEN OTHERS THEN
    RETURN extensions.ok((p_errcode IS NULL OR SQLSTATE = p_errcode) AND (p_errmsg IS NULL OR SQLERRM = p_errmsg), p_desc)
      || CASE WHEN (p_errcode IS NOT NULL AND SQLSTATE <> p_errcode) OR (p_errmsg IS NOT NULL AND SQLERRM <> p_errmsg)
              THEN E'\n#   caught: ' || SQLSTATE || ': ' || SQLERRM ELSE '' END;
  END;
  RETURN extensions.ok(false, p_desc) || E'\n#   no exception thrown';
END $$;
CREATE OR REPLACE FUNCTION extensions.throws_ok(p_sql text, p_errcode text, p_desc text) RETURNS text LANGUAGE sql AS
$$ SELECT extensions.throws_ok(p_sql, p_errcode, NULL, p_desc) $$;
CREATE OR REPLACE FUNCTION extensions.throws_ok(p_sql text, p_errcode text) RETURNS text LANGUAGE sql AS
$$ SELECT extensions.throws_ok(p_sql, p_errcode, NULL, '') $$;

CREATE OR REPLACE FUNCTION extensions.is_empty(p_sql text, p_desc text DEFAULT '') RETURNS text LANGUAGE plpgsql AS $$
DECLARE c bigint;
BEGIN EXECUTE 'SELECT count(*) FROM (' || p_sql || ') q' INTO c; RETURN extensions.ok(c = 0, p_desc); END $$;

CREATE OR REPLACE FUNCTION extensions.results_eq(p_have text, p_want text, p_desc text DEFAULT '') RETURNS text LANGUAGE plpgsql AS $$
DECLARE h text[]; w text[];
BEGIN
  EXECUTE 'SELECT coalesce(array_agg(q::text), ''{}'') FROM (' || p_have || ') q' INTO h;
  EXECUTE 'SELECT coalesce(array_agg(q::text), ''{}'') FROM (' || p_want || ') q' INTO w;
  RETURN extensions.ok(h = w, p_desc) || CASE WHEN h = w THEN '' ELSE E'\n#   have: ' || h::text || E'\n#   want: ' || w::text END;
END $$;

CREATE OR REPLACE FUNCTION extensions.set_eq(p_have text, p_want text, p_desc text DEFAULT '') RETURNS text LANGUAGE plpgsql AS $$
DECLARE c bigint;
BEGIN
  EXECUTE 'SELECT count(*) FROM ((' || p_have || ' EXCEPT ' || p_want || ') UNION ALL (' || p_want || ' EXCEPT ' || p_have || ')) q' INTO c;
  RETURN extensions.ok(c = 0, p_desc);
END $$;

CREATE OR REPLACE FUNCTION extensions.diag(m text) RETURNS text LANGUAGE sql AS $$ SELECT '# ' || m $$;

CREATE OR REPLACE FUNCTION extensions.finish() RETURNS SETOF text LANGUAGE plpgsql AS $$
DECLARE t extensions._tap;
BEGIN
  SELECT * INTO t FROM extensions._tap;
  IF t.planned IS DISTINCT FROM t.n THEN RETURN NEXT '# Looks like you planned ' || coalesce(t.planned::text,'?') || ' tests but ran ' || t.n; END IF;
  IF t.failed > 0 THEN RETURN NEXT '# Looks like you failed ' || t.failed || ' test(s) of ' || t.n; END IF;
END $$;
GRANT ALL ON extensions._tap TO PUBLIC;

-- Catalog assertions used by the VTID-05488 test (real pgTAP provides these natively).
CREATE OR REPLACE FUNCTION extensions.has_table(p_schema name, p_table name, p_desc text DEFAULT '') RETURNS text LANGUAGE sql AS
$$ SELECT extensions.ok(to_regclass(quote_ident(p_schema) || '.' || quote_ident(p_table)) IS NOT NULL, p_desc) $$;
CREATE OR REPLACE FUNCTION extensions.has_function(p_schema name, p_fn name, p_desc text DEFAULT '') RETURNS text LANGUAGE sql AS
$$ SELECT extensions.ok(EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                                 WHERE n.nspname = p_schema AND p.proname = p_fn), p_desc) $$;

-- VTID-05491 additions: like / doesnt_like (pgTAP).
CREATE OR REPLACE FUNCTION extensions.like(a text, pat text, p_desc text DEFAULT '') RETURNS text LANGUAGE plpgsql AS $$
BEGIN RETURN extensions.ok(a LIKE pat, p_desc) || CASE WHEN a LIKE pat THEN '' ELSE E'\n#   have: ' || coalesce(a, 'NULL') || E'\n#   want like: ' || pat END; END $$;
