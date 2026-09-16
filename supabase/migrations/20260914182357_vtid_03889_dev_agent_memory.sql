-- VTID-03889 — Operator Memory: dev_agent_memory
--
-- The Command Hub Operator (services/gateway/src/routes/operator.ts) has no
-- memory of its own. Memory Garden (memory_items/memory_facts/mem_episodes)
-- is community end-user personalization data, tenant/user-scoped -- entirely
-- unrelated to engineering work, and separately confirmed (live test,
-- 2026-09-14) to have been non-functional for semantic recall for 4.5
-- months: mem_episodes' write path (mirrorEpisode() in
-- services/gateway/src/services/mem-tier2-writer.ts) never attaches an
-- embedding, so every row since the table's first week has embedding=NULL,
-- and memory-broker.ts's relevance_score is actually list-position/recency
-- (`1 - (idx / hits.length)`) and static importance relabeled, not real
-- cosine similarity.
--
-- This table is a purpose-built, from-scratch fix to that exact failure
-- mode, not a reuse of the broken pattern:
--   - embedding is NOT NULL. There is no code path that can insert a row
--     without a real vector -- unlike mem_episodes, which happily accepted
--     (and still accepts) an embedding-less insert.
--   - Embedding provider is Amazon Titan Embeddings G2
--     (amazon.titan-embed-text-v2:0, 1024 dims), verified with a real
--     `aws bedrock-runtime invoke-model` call before this migration was
--     written -- not assumed to work because it's "configured".
--   - Retrieval (recall_dev_memory) orders by genuine pgvector cosine
--     distance (`embedding <=> query_embedding`), never by created_at or a
--     static importance column dressed up as relevance.

create table if not exists dev_agent_memory (
  id uuid primary key default gen_random_uuid(),
  vtid text,
  repo text not null check (repo in ('vitana-platform', 'vitana-v1')),
  category text not null check (category in
    ('decision', 'convention', 'incident', 'preference', 'task_outcome', 'gotcha')),
  title text not null,
  content text not null,
  -- Titan Embeddings G2 native output at default dimensionality.
  embedding vector(1024) not null,
  importance smallint not null default 50 check (importance between 0 and 100),
  source text not null check (source in ('session', 'autopilot', 'manual', 'backfill')),
  tags text[] not null default '{}',
  created_at timestamptz not null default now(),
  -- Auto-supersession, mirroring write_fact()'s pattern (VTID-01192) --
  -- a corrected/updated memory doesn't delete the old row, it points to it.
  superseded_by uuid references dev_agent_memory(id)
);

comment on table dev_agent_memory is
  'VTID-03889: Command Hub Operator engineering memory (decisions, conventions, '
  'incidents, preferences, task outcomes). NOT Memory Garden -- that is '
  'community end-user personalization and is a different concern entirely. '
  'embedding is NOT NULL by design: see migration header for why.';

create index if not exists dev_agent_memory_embedding_idx
  on dev_agent_memory using ivfflat (embedding vector_cosine_ops)
  with (lists = 100);

create index if not exists dev_agent_memory_repo_idx on dev_agent_memory (repo);
create index if not exists dev_agent_memory_vtid_idx on dev_agent_memory (vtid);
create index if not exists dev_agent_memory_active_idx
  on dev_agent_memory (repo, created_at desc) where superseded_by is null;

-- write_dev_memory() -- the only sanctioned way to insert a row. Takes the
-- embedding as an argument (computed by the caller via the Titan client --
-- see services/gateway/src/services/dev-memory-embedding.ts) rather than
-- computing it inside Postgres, since there is no in-database way to call
-- Bedrock. The NOT NULL constraint on the column is the actual enforcement;
-- this function exists for a consistent call shape and for supersession.
create or replace function write_dev_memory(
  p_repo text,
  p_category text,
  p_title text,
  p_content text,
  p_embedding vector(1024),
  p_vtid text default null,
  p_importance smallint default 50,
  p_source text default 'session',
  p_tags text[] default '{}',
  p_supersedes uuid default null
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  insert into dev_agent_memory (
    repo, category, title, content, embedding, vtid, importance, source, tags
  ) values (
    p_repo, p_category, p_title, p_content, p_embedding, p_vtid, p_importance, p_source, p_tags
  ) returning id into v_id;

  if p_supersedes is not null then
    update dev_agent_memory set superseded_by = v_id where id = p_supersedes;
  end if;

  return v_id;
end;
$$;

comment on function write_dev_memory is
  'VTID-03889: insert one dev_agent_memory row. embedding must be a real '
  'Titan Embeddings G2 vector computed by the caller -- there is no default '
  'and no fallback to a null/zero vector; the column is NOT NULL.';

-- recall_dev_memory() -- real cosine similarity, ordered by actual distance.
-- Deliberately excludes superseded rows so a corrected memory doesn't
-- compete with the version it replaced.
create or replace function recall_dev_memory(
  p_repo text,
  p_query_embedding vector(1024),
  p_limit int default 8,
  p_category text default null
) returns table (
  id uuid,
  vtid text,
  category text,
  title text,
  content text,
  importance smallint,
  source text,
  tags text[],
  created_at timestamptz,
  similarity float8
)
language sql
stable
security definer
set search_path = public
as $$
  select
    m.id, m.vtid, m.category, m.title, m.content, m.importance, m.source, m.tags, m.created_at,
    (1 - (m.embedding <=> p_query_embedding))::float8 as similarity
  from dev_agent_memory m
  where m.repo = p_repo
    and m.superseded_by is null
    and (p_category is null or m.category = p_category)
  order by m.embedding <=> p_query_embedding
  limit p_limit;
$$;

comment on function recall_dev_memory is
  'VTID-03889: real pgvector cosine-distance recall. similarity is '
  '1 - cosine_distance, genuinely computed against the query embedding -- '
  'never a list-position or importance-column stand-in. Compare against '
  'memory-broker.ts''s fetchEpisodicLegacySemantic/relevance_score, which is '
  'exactly the mistake this function exists not to repeat.';

grant execute on function write_dev_memory to service_role;
grant execute on function recall_dev_memory to service_role;
