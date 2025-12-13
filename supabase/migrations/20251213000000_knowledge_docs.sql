-- VTID-0538: Knowledge Hub v2 - Document Storage for Operator Chat
-- Purpose: Enable doc-grounded answers in Operator Console via full-text search
-- Idempotent: Safe to run multiple times

-- Step 1: Create knowledge_docs table
CREATE TABLE IF NOT EXISTS public.knowledge_docs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title       text NOT NULL,
  path        text NOT NULL UNIQUE,
  content     text NOT NULL,
  source_type text DEFAULT 'markdown',  -- markdown, json-kb, spec
  tags        text[] DEFAULT '{}',
  word_count  int DEFAULT 0,
  created_at  timestamptz DEFAULT now(),
  updated_at  timestamptz DEFAULT now()
);

-- Step 2: Add generated tsvector column for full-text search
-- This column is automatically updated when content changes
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'knowledge_docs'
      AND column_name = 'content_tsv'
  ) THEN
    ALTER TABLE public.knowledge_docs
      ADD COLUMN content_tsv tsvector
      GENERATED ALWAYS AS (to_tsvector('english', coalesce(title, '') || ' ' || coalesce(content, ''))) STORED;
    RAISE NOTICE 'Added content_tsv column to knowledge_docs';
  ELSE
    RAISE NOTICE 'content_tsv column already exists';
  END IF;
END$$;

-- Step 3: Create GIN index for fast full-text search
CREATE INDEX IF NOT EXISTS knowledge_docs_content_tsv_idx
  ON public.knowledge_docs USING GIN (content_tsv);

-- Step 4: Create additional indexes
CREATE INDEX IF NOT EXISTS knowledge_docs_path_idx
  ON public.knowledge_docs (path);

CREATE INDEX IF NOT EXISTS knowledge_docs_source_type_idx
  ON public.knowledge_docs (source_type);

CREATE INDEX IF NOT EXISTS knowledge_docs_updated_at_idx
  ON public.knowledge_docs (updated_at DESC);

-- Step 5: Create search function for convenient querying
CREATE OR REPLACE FUNCTION public.search_knowledge_docs(
  search_query text,
  max_results int DEFAULT 10
)
RETURNS TABLE(
  id uuid,
  title text,
  path text,
  snippet text,
  source_type text,
  tags text[],
  score real
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    kd.id,
    kd.title,
    kd.path,
    ts_headline(
      'english',
      kd.content,
      plainto_tsquery('english', search_query),
      'MaxFragments=2, MaxWords=50, MinWords=20, StartSel=**, StopSel=**'
    ) as snippet,
    kd.source_type,
    kd.tags,
    ts_rank(kd.content_tsv, plainto_tsquery('english', search_query)) as score
  FROM public.knowledge_docs kd
  WHERE kd.content_tsv @@ plainto_tsquery('english', search_query)
  ORDER BY score DESC
  LIMIT max_results;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

-- Step 6: Create upsert function for doc ingestion
CREATE OR REPLACE FUNCTION public.upsert_knowledge_doc(
  p_title text,
  p_path text,
  p_content text,
  p_source_type text DEFAULT 'markdown',
  p_tags text[] DEFAULT '{}'
)
RETURNS uuid AS $$
DECLARE
  result_id uuid;
BEGIN
  INSERT INTO public.knowledge_docs (title, path, content, source_type, tags, word_count, updated_at)
  VALUES (
    p_title,
    p_path,
    p_content,
    p_source_type,
    p_tags,
    array_length(regexp_split_to_array(p_content, '\s+'), 1)
  )
  ON CONFLICT (path) DO UPDATE SET
    title = EXCLUDED.title,
    content = EXCLUDED.content,
    source_type = EXCLUDED.source_type,
    tags = EXCLUDED.tags,
    word_count = array_length(regexp_split_to_array(EXCLUDED.content, '\s+'), 1),
    updated_at = now()
  RETURNING id INTO result_id;

  RETURN result_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Step 7: Grant permissions
GRANT SELECT ON public.knowledge_docs TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.knowledge_docs TO service_role;
GRANT EXECUTE ON FUNCTION public.search_knowledge_docs(text, int) TO authenticated;
GRANT EXECUTE ON FUNCTION public.search_knowledge_docs(text, int) TO service_role;
GRANT EXECUTE ON FUNCTION public.upsert_knowledge_doc(text, text, text, text, text[]) TO service_role;

-- Step 8: Add documentation comments
COMMENT ON TABLE public.knowledge_docs IS 'VTID-0538: Knowledge Hub document storage for Operator Chat full-text search';
COMMENT ON COLUMN public.knowledge_docs.content_tsv IS 'Auto-generated tsvector for full-text search';
COMMENT ON FUNCTION public.search_knowledge_docs IS 'Search knowledge docs with full-text ranking and snippets';
COMMENT ON FUNCTION public.upsert_knowledge_doc IS 'Insert or update a knowledge doc by path';

-- Verification query (run manually):
-- SELECT * FROM search_knowledge_docs('Vitana Index', 5);
