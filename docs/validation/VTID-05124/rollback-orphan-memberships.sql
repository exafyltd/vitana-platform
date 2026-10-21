-- VTID-05124 rollback for data-fixups/20261012214500_vtid_05124_delete_orphan_memberships.sql.
-- Re-inserts the archived memberships rows exactly as they were (all 7 columns, same ids and
-- timestamps) from legacy_archive.bak_fu8_orphan_memberships_20261012 (kept 30 days).
-- memberships has no triggers, so the insert has no side effects. A row whose (user_id,
-- tenant_id) was re-created in the meantime raises on the unique key and aborts the whole
-- rollback: decide about that row by hand, do not force it.

BEGIN;

SET LOCAL lock_timeout = '3s';

INSERT INTO public.memberships (id, user_id, tenant_id, role, status, created_at, updated_at)
SELECT id, user_id, tenant_id, role, status, created_at, updated_at
  FROM legacy_archive.bak_fu8_orphan_memberships_20261012
ON CONFLICT (id) DO NOTHING;

DO $$
DECLARE archived int; restored int;
BEGIN
  SELECT count(*) INTO archived FROM legacy_archive.bak_fu8_orphan_memberships_20261012;
  SELECT count(*) INTO restored
    FROM legacy_archive.bak_fu8_orphan_memberships_20261012 b
    JOIN public.memberships m
      ON m.id = b.id AND m.user_id = b.user_id AND m.tenant_id = b.tenant_id AND m.role = b.role
     AND m.status = b.status AND m.created_at = b.created_at AND m.updated_at = b.updated_at;
  IF restored <> archived THEN
    RAISE EXCEPTION 'VTID-05124 rollback: % of % archived memberships restored identically — aborting', restored, archived;
  END IF;
END $$;

COMMIT;
