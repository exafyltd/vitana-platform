-- VTID-05520: a pgTAP-compatible assertion shim for the PGlite local stack. Real pgTAP is NOT used here.
-- It covers the assertions the lanes' suites need: plan, ok, is, isnt, matches, doesnt_match, lives_ok, throws_ok,
-- is_empty, results_eq, set_eq, diag, finish, plus require_table (fails, never passes, on a not-replayable table).
-- Not covered: pgTAP catalog assertions (has_table, policies_are, ...), skip/todo, and the TAP protocol beyond plain lines.
CREATE SCHEMA IF NOT EXISTS tap;
CREATE TABLE IF NOT EXISTS tap.state (id int PRIMARY KEY DEFAULT 1, n int NOT NULL DEFAULT 0, failed int NOT NULL DEFAULT 0, planned int);
INSERT INTO tap.state (id) VALUES (1) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS tap.not_replayable (table_name text PRIMARY KEY, reason text NOT NULL, lanes text NOT NULL);

CREATE OR REPLACE FUNCTION tap.plan(p int) RETURNS text LANGUAGE plpgsql AS $$
BEGIN UPDATE tap.state SET n = 0, failed = 0, planned = p; RETURN '1..' || p; END $$;

CREATE OR REPLACE FUNCTION tap.ok(p_ok boolean, p_desc text DEFAULT '') RETURNS text LANGUAGE plpgsql AS $$
DECLARE v int;
BEGIN
  UPDATE tap.state SET n = n + 1, failed = failed + CASE WHEN coalesce(p_ok, false) THEN 0 ELSE 1 END RETURNING n INTO v;
  RETURN CASE WHEN coalesce(p_ok, false) THEN 'ok ' ELSE 'not ok ' END || v || ' - ' || coalesce(p_desc, '');
END $$;

CREATE OR REPLACE FUNCTION tap.is(a anyelement, b anyelement, p_desc text DEFAULT '') RETURNS text LANGUAGE plpgsql AS $$
DECLARE r text;
BEGIN
  r := tap.ok(a IS NOT DISTINCT FROM b, p_desc);
  IF a IS DISTINCT FROM b THEN r := r || E'\n#   have: ' || coalesce(a::text, 'NULL') || E'\n#   want: ' || coalesce(b::text, 'NULL'); END IF;
  RETURN r;
END $$;

CREATE OR REPLACE FUNCTION tap.isnt(a anyelement, b anyelement, p_desc text DEFAULT '') RETURNS text LANGUAGE sql AS
$$ SELECT tap.ok(a IS DISTINCT FROM b, p_desc) $$;

CREATE OR REPLACE FUNCTION tap.matches(a text, re text, p_desc text DEFAULT '') RETURNS text LANGUAGE sql AS
$$ SELECT tap.ok(a ~ re, p_desc) $$;

CREATE OR REPLACE FUNCTION tap.doesnt_match(a text, re text, p_desc text DEFAULT '') RETURNS text LANGUAGE sql AS
$$ SELECT tap.ok(a !~ re, p_desc) $$;

CREATE OR REPLACE FUNCTION tap.lives_ok(p_sql text, p_desc text DEFAULT '') RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  BEGIN EXECUTE p_sql; EXCEPTION WHEN OTHERS THEN
    RETURN tap.ok(false, p_desc) || E'\n#   died: ' || SQLSTATE || ' ' || SQLERRM;
  END;
  RETURN tap.ok(true, p_desc);
END $$;

CREATE OR REPLACE FUNCTION tap.throws_ok(p_sql text, p_errcode text, p_errmsg text, p_desc text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  BEGIN EXECUTE p_sql; EXCEPTION WHEN OTHERS THEN
    RETURN tap.ok((p_errcode IS NULL OR SQLSTATE = p_errcode) AND (p_errmsg IS NULL OR SQLERRM = p_errmsg), p_desc)
      || CASE WHEN (p_errcode IS NOT NULL AND SQLSTATE <> p_errcode) OR (p_errmsg IS NOT NULL AND SQLERRM <> p_errmsg)
              THEN E'\n#   caught: ' || SQLSTATE || ': ' || SQLERRM ELSE '' END;
  END;
  RETURN tap.ok(false, p_desc) || E'\n#   no exception thrown';
END $$;
CREATE OR REPLACE FUNCTION tap.throws_ok(p_sql text, p_errcode text, p_desc text) RETURNS text LANGUAGE sql AS
$$ SELECT tap.throws_ok(p_sql, p_errcode, NULL, p_desc) $$;
CREATE OR REPLACE FUNCTION tap.throws_ok(p_sql text, p_errcode text) RETURNS text LANGUAGE sql AS
$$ SELECT tap.throws_ok(p_sql, p_errcode, NULL, '') $$;

CREATE OR REPLACE FUNCTION tap.is_empty(p_sql text, p_desc text DEFAULT '') RETURNS text LANGUAGE plpgsql AS $$
DECLARE c bigint;
BEGIN EXECUTE 'SELECT count(*) FROM (' || p_sql || ') q' INTO c; RETURN tap.ok(c = 0, p_desc); END $$;

CREATE OR REPLACE FUNCTION tap.results_eq(p_have text, p_want text, p_desc text DEFAULT '') RETURNS text LANGUAGE plpgsql AS $$
DECLARE h text[]; w text[];
BEGIN
  EXECUTE 'SELECT coalesce(array_agg(q::text), ''{}'') FROM (' || p_have || ') q' INTO h;
  EXECUTE 'SELECT coalesce(array_agg(q::text), ''{}'') FROM (' || p_want || ') q' INTO w;
  RETURN tap.ok(h = w, p_desc) || CASE WHEN h = w THEN '' ELSE E'\n#   have: ' || h::text || E'\n#   want: ' || w::text END;
END $$;

CREATE OR REPLACE FUNCTION tap.set_eq(p_have text, p_want text, p_desc text DEFAULT '') RETURNS text LANGUAGE plpgsql AS $$
DECLARE c bigint;
BEGIN
  EXECUTE 'SELECT count(*) FROM ((' || p_have || ' EXCEPT ' || p_want || ') UNION ALL (' || p_want || ' EXCEPT ' || p_have || ')) q' INTO c;
  RETURN tap.ok(c = 0, p_desc);
END $$;

-- A claim that needs a table fails when the table is missing; when the table is listed in not-replayable.txt the
-- failure says "unverified" and why (plan.md Amendment 3, decision 3). A listed table never passes.
CREATE OR REPLACE FUNCTION tap.require_table(p_table text, p_desc text DEFAULT NULL) RETURNS text LANGUAGE plpgsql AS $$
DECLARE v_reason text; v_lanes text; v_desc text := coalesce(p_desc, 'table ' || p_table || ' is replayed');
BEGIN
  IF to_regclass('public.' || quote_ident(p_table)) IS NOT NULL THEN RETURN tap.ok(true, v_desc); END IF;
  SELECT reason, lanes INTO v_reason, v_lanes FROM tap.not_replayable WHERE table_name = p_table;
  IF v_reason IS NOT NULL THEN
    RETURN tap.ok(false, v_desc) || E'\n#   unverified: table ' || p_table || ' is not replayable on this stack: ' || v_reason
      || E'\n#   needed by: ' || v_lanes;
  END IF;
  RETURN tap.ok(false, v_desc) || E'\n#   table ' || p_table || ' does not exist';
END $$;

CREATE OR REPLACE FUNCTION tap.diag(m text) RETURNS text LANGUAGE sql AS $$ SELECT '# ' || m $$;

CREATE OR REPLACE FUNCTION tap.finish() RETURNS SETOF text LANGUAGE plpgsql AS $$
DECLARE t tap.state;
BEGIN
  SELECT * INTO t FROM tap.state;
  IF t.planned IS DISTINCT FROM t.n THEN RETURN NEXT '# Looks like you planned ' || coalesce(t.planned::text,'?') || ' tests but ran ' || t.n; END IF;
  IF t.failed > 0 THEN RETURN NEXT '# Looks like you failed ' || t.failed || ' test(s) of ' || t.n; END IF;
END $$;

GRANT USAGE ON SCHEMA tap TO PUBLIC;
GRANT ALL ON ALL TABLES IN SCHEMA tap TO PUBLIC;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA tap TO PUBLIC;
