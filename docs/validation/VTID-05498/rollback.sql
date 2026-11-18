-- VTID-05498 rollback: drops the one column the migration added. Safe only while no overlay row exists or the
-- overlay rows may be discarded (kb-overlay-code writes none today). Roll back the gateway reader first.
-- Owner approval required before it is applied anywhere (collaboration.md section 7d).
BEGIN;
ALTER TABLE public.knowledge_docs DROP COLUMN IF EXISTS tenant_id;
COMMIT;
