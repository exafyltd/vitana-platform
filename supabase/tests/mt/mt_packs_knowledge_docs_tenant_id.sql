-- VTID-05498 (mt-packs-r2/kb-overlay-db) — pgTAP: public.knowledge_docs.tenant_id (KB tenant overlay column).
-- Runs on a throwaway Postgres after 20261102080000_mt_packs_knowledge_docs_tenant_id.sql.
-- One transaction, rolled back at the end: never against a shared or live database.
BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET search_path = public, extensions;

SELECT plan(15);

INSERT INTO public.tenants (slug, name) VALUES ('t05498a', 'Tenant A 05498'), ('t05498b', 'Tenant B 05498');
CREATE TEMP TABLE t05498_ids AS
  SELECT (SELECT tenant_id FROM public.tenants WHERE slug = 't05498a') AS ta,
         (SELECT tenant_id FROM public.tenants WHERE slug = 't05498b') AS tb;

-- Structure ------------------------------------------------------------------
SELECT has_column('public', 'knowledge_docs', 'tenant_id', 'knowledge_docs.tenant_id exists');
SELECT is((SELECT data_type FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'knowledge_docs' AND column_name = 'tenant_id'),
          'uuid', 'tenant_id is uuid');
SELECT is((SELECT is_nullable FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'knowledge_docs' AND column_name = 'tenant_id'),
          'YES', 'tenant_id is nullable (NULL = platform baseline)');
SELECT is((SELECT column_default FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'knowledge_docs' AND column_name = 'tenant_id'),
          NULL, 'tenant_id has no default');
SELECT is((SELECT count(*)::int FROM pg_constraint c
            WHERE c.conrelid = 'public.knowledge_docs'::regclass AND c.contype = 'f'
              AND c.confrelid = 'public.tenants'::regclass), 1, 'one foreign key from knowledge_docs to tenants');
SELECT is((SELECT a.attname FROM pg_constraint c
             JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = c.confkey[1]
            WHERE c.conrelid = 'public.knowledge_docs'::regclass AND c.contype = 'f'
              AND c.confrelid = 'public.tenants'::regclass), 'tenant_id', 'the foreign key targets tenants(tenant_id), the live key');
SELECT is((SELECT string_agg(column_name, ',' ORDER BY ordinal_position)
             FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'knowledge_docs' AND column_name <> 'tenant_id'),
          'id,title,path,content,source_type,tags,word_count,created_at,updated_at,content_tsv',
          'every existing column is unchanged and in place');

-- Expand-only: no backfill ---------------------------------------------------------
-- Independent of baseline data: whatever rows exist before this test inserts anything (none on a bare database, many
-- on a seeded one) must all be NULL after the migration.
SELECT is((SELECT count(*)::int FROM public.knowledge_docs WHERE tenant_id IS NULL),
          (SELECT count(*)::int FROM public.knowledge_docs), 'every pre-existing row stays NULL (no backfill)');
SELECT is((SELECT count(*)::int FROM public.knowledge_docs WHERE tenant_id IS NOT NULL), 0, 'no row carries a tenant before any overlay write');

-- Behaviour ---------------------------------------------------------------------------
INSERT INTO public.knowledge_docs (title, path, content) VALUES ('Baseline doc', 'vtid05498/kb/99-new-baseline.md', 'baseline');
SELECT is((SELECT tenant_id IS NULL FROM public.knowledge_docs WHERE path = 'vtid05498/kb/99-new-baseline.md'),
          true, 'a baseline insert that omits tenant_id resolves as NULL (old writers keep working)');
INSERT INTO public.knowledge_docs (title, path, content, tenant_id)
  VALUES ('Overlay A', 'vtid05498/tenant/a/overlay.md', 'overlay a', (SELECT ta FROM t05498_ids));
SELECT is((SELECT count(*)::int FROM public.knowledge_docs WHERE tenant_id = (SELECT ta FROM t05498_ids)), 1, 'an overlay row for tenant A is stored');
SELECT is((SELECT count(*)::int FROM public.knowledge_docs WHERE tenant_id = (SELECT tb FROM t05498_ids)), 0, 'tenant B sees no overlay row of tenant A');
-- Filtered to this test's own rows (path prefix vtid05498/), so it does not depend on how many baseline rows exist.
SELECT is((SELECT count(*)::int FROM public.knowledge_docs
            WHERE path LIKE 'vtid05498/%' AND (tenant_id IS NULL OR tenant_id = (SELECT tb FROM t05498_ids))),
          1, 'baseline plus tenant B overlay resolves to this test''s baseline row only (tenant A overlay excluded)');
SELECT throws_ok(
  $q$INSERT INTO public.knowledge_docs (title, path, content, tenant_id)
     VALUES ('Bad', 'vtid05498/tenant/x/bad.md', 'x', '00000000-0000-4000-8000-0000000000ff')$q$,
  '23503', NULL, 'an unknown tenant violates the foreign key');
SELECT throws_ok(
  $q$INSERT INTO public.knowledge_docs (title, path, content, tenant_id)
     VALUES ('Dup', 'vtid05498/tenant/a/overlay.md', 'x', NULL)$q$,
  '23505', NULL, 'path stays unique across baseline and overlay (an overlay needs its own path)');

SELECT * FROM finish();
ROLLBACK;
