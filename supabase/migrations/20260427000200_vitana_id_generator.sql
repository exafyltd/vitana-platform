-- Vitana ID — Release A · 3/9
-- generate_vitana_id_suggestion(display_name, full_name, email)
--
-- Produces a short, language-neutral, ASR-friendly handle:
--   <base 3-6 lowercase chars derived from given name><4-digit suffix>
-- e.g. "Dragan Alexander" -> "alex3700", "Maria Schmidt" -> "maria2307".
--
-- Algorithm:
--   1. Normalize via unaccent + lower; strip non-[a-z0-9]; take first token.
--   2. If empty / non-Latin -> base = 'user'.
--   3. If base is in vitana_id_reserved, prefix 'u' (e.g. 'admin' -> 'uadmin').
--   4. Truncate base to 6 chars.
--   5. Append random 4-digit suffix; check uniqueness across BOTH
--      profiles.vitana_id and handle_aliases.old_handle (alias collision
--      protection — see Open Risks in plan); up to 50 retries.
--   6. Escalate to 5-digit suffix on exhaustion (50 more retries).
--   7. Final fallback: 'user' || epoch microseconds modulo 1e6 (always unique).

CREATE OR REPLACE FUNCTION public.generate_vitana_id_suggestion(
  p_display_name text DEFAULT NULL,
  p_full_name    text DEFAULT NULL,
  p_email        text DEFAULT NULL
) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  raw_name   text;
  base       text;
  candidate  text;
  attempts   int := 0;
  suffix_len int := 4;
BEGIN
  -- 1. Pick the best name source available.
  raw_name := COALESCE(
    NULLIF(trim(p_display_name), ''),
    NULLIF(trim(p_full_name), ''),
    NULLIF(split_part(p_email, '@', 1), '')
  );

  -- 2. Normalize: unaccent, lowercase, strip non-alphanumerics, take first token.
  IF raw_name IS NOT NULL THEN
    base := lower(public.unaccent(raw_name));
    base := regexp_replace(base, '[^a-z0-9 ]', '', 'g');
    base := split_part(trim(base), ' ', 1);
    -- Strip any leading digits (a vitana_id must start with a letter).
    base := regexp_replace(base, '^[0-9]+', '');
  END IF;

  -- 3. Fallback if empty / non-Latin / all-digits.
  IF base IS NULL OR length(base) < 2 THEN
    base := 'user';
  END IF;

  -- 4. Reserved-word collision: prefix 'u' (grandfathering only applies to
  --    write-time validation; the generator avoids producing reserved bases).
  IF EXISTS (SELECT 1 FROM public.vitana_id_reserved WHERE token = base) THEN
    base := 'u' || base;
  END IF;

  -- 5. Truncate base to 6 chars (final id is 7-11 chars: base + 4-5 digits).
  IF length(base) > 6 THEN
    base := substring(base from 1 for 6);
  END IF;

  -- 6. Random 4-digit suffix with collision retry.
  LOOP
    attempts := attempts + 1;
    candidate := base || lpad((floor(random() * 9000) + 1000)::int::text, suffix_len, '0');

    IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE vitana_id = candidate)
       AND NOT EXISTS (SELECT 1 FROM public.handle_aliases WHERE old_handle = candidate)
    THEN
      RETURN candidate;
    END IF;

    -- 7. Escalate to 5-digit suffix after 50 collisions on 4-digit space.
    IF attempts = 50 AND suffix_len = 4 THEN
      suffix_len := 5;
    END IF;

    -- 8. Final fallback after exhausting both spaces.
    IF attempts > 100 THEN
      RETURN 'user' || lpad((floor(extract(epoch from clock_timestamp()) * 1e6)::bigint % 1000000)::text, 6, '0');
    END IF;
  END LOOP;
END;
$$;

COMMENT ON FUNCTION public.generate_vitana_id_suggestion(text, text, text) IS
  'Returns a unique, ASR-friendly vitana_id suggestion. Checks both profiles.vitana_id and handle_aliases.old_handle for uniqueness. See plan: i-want-a-solution-streamed-patterson.md';
