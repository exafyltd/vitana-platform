-- VTID-04407 — developer memory, Phase 3 of docs/MEMORY-SYSTEM-PLAN.md.
--
-- Two additions to dev_agent_memory, both additive:
--
-- 1. author_user_id — who the row is about/for. Until now every row was
--    repo-wide, so "what was I doing yesterday" had no answer: a handoff
--    written at the end of one person's Operator thread is useless mixed
--    into everyone's recall. NULL keeps the old meaning (repo-wide
--    knowledge: decisions, conventions, incidents); a non-null value marks
--    a row as one person's working state.
--
-- 2. category 'handoff' — the end-of-thread / nightly "where I stopped,
--    what is open, what is next" note. Read by the morning pack
--    (GET /api/v1/dev-memory/morning-pack, VTID-04408), not by semantic
--    recall: recall_dev_memory() excludes handoffs so a stale "next step"
--    from last week never competes with real knowledge for the top-K.
--
-- write_dev_memory() is dropped and recreated with one more defaulted
-- parameter, the same way 20260921120000 added file_paths/stage: exactly
-- one overload exists afterwards, so PostgREST never has to choose.

alter table dev_agent_memory
  add column if not exists author_user_id uuid;

comment on column dev_agent_memory.author_user_id is
  'VTID-04407: the person this row belongs to (a handoff, a personal '
  'preference). NULL = repo-wide knowledge shared by every session and agent.';

alter table dev_agent_memory drop constraint if exists dev_agent_memory_category_check;
alter table dev_agent_memory add constraint dev_agent_memory_category_check
  check (category = any (array[
    'decision', 'convention', 'incident', 'preference', 'task_outcome', 'gotcha', 'handoff'
  ]));

create index if not exists dev_agent_memory_author_recent_idx
  on dev_agent_memory (author_user_id, category, created_at desc)
  where superseded_by is null;

drop function if exists write_dev_memory(
  text, text, text, text, vector(1024), text, smallint, text, text[], uuid, text[], text
);

create function write_dev_memory(
  p_repo text,
  p_category text,
  p_title text,
  p_content text,
  p_embedding vector(1024),
  p_vtid text default null,
  p_importance smallint default 50,
  p_source text default 'session',
  p_tags text[] default '{}',
  p_supersedes uuid default null,
  p_file_paths text[] default '{}',
  p_stage text default null,
  p_author_user_id uuid default null
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  insert into dev_agent_memory (
    repo, category, title, content, embedding, vtid, importance, source, tags,
    file_paths, stage, author_user_id
  ) values (
    p_repo, p_category, p_title, p_content, p_embedding, p_vtid, p_importance, p_source, p_tags,
    p_file_paths, p_stage, p_author_user_id
  ) returning id into v_id;

  if p_supersedes is not null then
    update dev_agent_memory set superseded_by = v_id where id = p_supersedes;
  end if;

  return v_id;
end;
$$;

comment on function write_dev_memory(
  text, text, text, text, vector(1024), text, smallint, text, text[], uuid, text[], text, uuid
) is
  'VTID-03889 / VTID-04224 / VTID-04407: insert one dev_agent_memory row. '
  'embedding must be a real vector computed by the caller (NOT NULL column, '
  'no fallback). file_paths, stage and author_user_id are optional.';

revoke all on function write_dev_memory(
  text, text, text, text, vector(1024), text, smallint, text, text[], uuid, text[], text, uuid
) from public, anon, authenticated;
grant execute on function write_dev_memory(
  text, text, text, text, vector(1024), text, smallint, text, text[], uuid, text[], text, uuid
) to service_role;

-- Semantic recall stays knowledge-only: handoffs are working state, read
-- in order by the morning pack, never ranked against decisions.
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
    and (p_category = 'handoff' or m.category <> 'handoff')
  order by m.embedding <=> p_query_embedding
  limit p_limit;
$$;
