CREATE SEQUENCE IF NOT EXISTS vtid_seq START 1 INCREMENT 1;

CREATE OR REPLACE FUNCTION next_vtid(p_family TEXT, p_module TEXT)
RETURNS TEXT LANGUAGE plpgsql AS $$
DECLARE
  n BIGINT := nextval('vtid_seq');
  fam TEXT := upper(p_family);
  mod TEXT := upper(p_module);
BEGIN
  RETURN format('%s-%s-%s-%04s', fam, mod, to_char(now(),'YYYY'), n);
END $$;

GRANT EXECUTE ON FUNCTION next_vtid(TEXT, TEXT) TO service_role;
GRANT USAGE, SELECT ON SEQUENCE vtid_seq TO service_role;
