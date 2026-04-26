-- Vitana ID — Release A · 2/9
-- Reserved-word table. The canonical source of truth for tokens that
-- MUST NOT appear as a base in any generated or user-picked vitana_id.
-- Both the SQL generator and the gateway validator query this table;
-- the frontend pre-validates by calling the same gateway endpoint, so
-- there is exactly one list to maintain.

CREATE TABLE IF NOT EXISTS public.vitana_id_reserved (
  token text PRIMARY KEY
);

COMMENT ON TABLE public.vitana_id_reserved IS
  'Tokens disallowed as a vitana_id base. Generator prefixes ''u'' on collision. Validator rejects exact matches at write time. Existing holders are grandfathered (validation only at write).';

INSERT INTO public.vitana_id_reserved (token) VALUES
  ('admin'),
  ('support'),
  ('claim'),
  ('claims'),
  ('ticket'),
  ('tickets'),
  ('incident'),
  ('ops'),
  ('system'),
  ('vitana'),
  ('orb'),
  ('root'),
  ('null'),
  ('undefined'),
  ('anonymous'),
  ('user'),
  ('users'),
  ('api'),
  ('dev'),
  ('developer'),
  ('exafy'),
  ('official'),
  ('help'),
  ('helpdesk'),
  ('mod'),
  ('moderator'),
  ('moderation'),
  ('abuse'),
  ('security'),
  ('billing'),
  ('payment')
ON CONFLICT (token) DO NOTHING;
