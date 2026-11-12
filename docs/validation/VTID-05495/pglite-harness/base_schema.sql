-- VTID-05495 PGlite stand-in for the one live table the migration references: tenants (live key tenants.tenant_id, VTID-04716).
CREATE TABLE public.tenants (
  tenant_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text UNIQUE NOT NULL,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
