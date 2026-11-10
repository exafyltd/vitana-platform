-- VTID-05498 (mt-packs-r2/kb-overlay-db): knowledge_docs tenant overlay column.
--
-- Adds one nullable column, public.knowledge_docs.tenant_id, so a tenant can publish its own knowledge-base
-- documents on top of the platform baseline. NULL means "platform baseline" (every existing row, and every row an old
-- writer inserts without the column). A non-NULL value marks an overlay document owned by that tenant.
-- Expand-only: no backfill, no NOT NULL, no default, no index, no policy change, no change to an existing column.
-- Nothing reads or writes the column in this change (the readers are the kb-overlay-code lane).
--
-- The live tenants key is tenants(tenant_id) (VTID-04716); the plan text says tenants(id), the live schema wins.
-- Idempotent (ADD COLUMN IF NOT EXISTS), safe to run twice.
--
-- Locking: ADD COLUMN with no default is a catalog-only change, but it still needs a brief ACCESS EXCLUSIVE lock on
-- knowledge_docs and a SHARE ROW EXCLUSIVE lock on tenants (for the foreign key). lock_timeout makes the statement
-- fail fast instead of queueing behind a long query and blocking readers. If it times out, nothing was changed:
-- re-run the file (RUN-MIGRATION) until it passes, at a quiet moment.
-- Rollback: docs/validation/VTID-05498/rollback.sql (DROP COLUMN).
-- Order: docs/multitenancy/MIGRATION-QUEUE.md.

BEGIN;

SET LOCAL lock_timeout = '5s';

DO $$
BEGIN
  IF to_regclass('public.knowledge_docs') IS NULL THEN
    RAISE EXCEPTION 'VTID-05498: public.knowledge_docs is missing; refusing to add the tenant overlay column';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'tenants' AND column_name = 'tenant_id'
  ) THEN
    RAISE EXCEPTION 'VTID-05498: public.tenants(tenant_id) is missing; refusing to add the tenant overlay column';
  END IF;
END
$$;

ALTER TABLE public.knowledge_docs
  ADD COLUMN IF NOT EXISTS tenant_id uuid NULL REFERENCES public.tenants(tenant_id);

COMMENT ON COLUMN public.knowledge_docs.tenant_id IS
  'VTID-05498: tenant overlay owner. NULL = platform baseline document; non-NULL = overlay document of that tenant.';

COMMIT;
