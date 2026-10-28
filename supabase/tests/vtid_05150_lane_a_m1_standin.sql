-- VTID-05150 harness stand-in for Lane A M1 (VTID-05149,
-- 20261014000100_vtid_05149_tenants_default_platform_flags.sql), used only when
-- that migration is not in the checkout yet. Same columns, CHECK, partial unique
-- index and maxina default as A's plan Fix 1; the deferred "exactly one default"
-- trigger is A's own concern and is left out here.
ALTER TABLE public.tenants
  ADD COLUMN is_default boolean NOT NULL DEFAULT false,
  ADD COLUMN is_platform boolean NOT NULL DEFAULT false;
ALTER TABLE public.tenants ADD CONSTRAINT tenants_default_not_platform CHECK (NOT (is_default AND is_platform));
CREATE UNIQUE INDEX tenants_one_default ON public.tenants ((true)) WHERE is_default;
UPDATE public.tenants SET is_default = true WHERE slug = 'maxina';
