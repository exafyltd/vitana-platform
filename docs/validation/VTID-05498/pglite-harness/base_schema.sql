-- VTID-05498 PGlite stand-ins for the two live tables the migration touches: tenants (live key tenants.tenant_id, VTID-04716)
-- and knowledge_docs (from 20251213000000_knowledge_docs.sql, with the generated tsvector column).
CREATE TABLE public.tenants (
  tenant_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text UNIQUE NOT NULL,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.knowledge_docs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title       text NOT NULL,
  path        text NOT NULL UNIQUE,
  content     text NOT NULL,
  source_type text DEFAULT 'markdown',
  tags        text[] DEFAULT '{}',
  word_count  int DEFAULT 0,
  created_at  timestamptz DEFAULT now(),
  updated_at  timestamptz DEFAULT now(),
  content_tsv tsvector GENERATED ALWAYS AS (to_tsvector('english', coalesce(title, '') || ' ' || coalesce(content, ''))) STORED
);
