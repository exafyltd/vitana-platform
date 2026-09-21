-- BOOTSTRAP — dev_agent_memory: file-scoped recall + stage provenance
--
-- Extends dev_agent_memory (VTID-03889, Operator Console engineering
-- memory) so the Planner/Worker/Validator LLM routing stages can read
-- and write it too -- today only the `memory` extraction stage
-- (Operator Console turns) and the Dev Autopilot executor's outcome
-- writer (`recordExecutionOutcomeMemory`) ever touch this table.
--
-- Two additive columns:
--   - file_paths text[]: the concrete repo-relative files a memory row
--     is about (the diff's changed files on write, a task's target
--     files on read). Plain array-overlap (&&) -- both sides are
--     concrete paths, never glob patterns, so no glob-matching helper
--     is needed on the read side.
--   - stage text: which routing stage produced the row (provenance
--     only -- it never restricts which stage may RECALL a row; a
--     gotcha the Worker found on a file is exactly what the Planner
--     should see before planning a similar change to that file again).
--
-- Every existing row, index, constraint and RPC signature is left
-- intact -- this is purely additive. write_dev_memory() gains two new,
-- defaulted, TRAILING parameters, so every existing caller (today:
-- operator-turn-memory.ts's two writers) compiles and runs unchanged.
--
-- NOT applied to any live database from this session -- no live
-- Supabase/production write access was exercised here. Apply the same
-- way this repo's own governed path expects (Supabase MCP, ahead of
-- the Migration Drift Check) before merging code that depends on the
-- new column or the new recall_dev_memory_by_files() RPC.

alter table dev_agent_memory
  add column if not exists file_paths text[] not null default '{}';

alter table dev_agent_memory
  add column if not exists stage text
    check (stage is null or stage in ('operator', 'planner', 'worker', 'validator'));

comment on column dev_agent_memory.file_paths is
  'Concrete repo-relative file paths this memory is about (changed files '
  'on a write, target files on a read query). Plain array, no globs -- '
  'matched by && overlap against a task''s own concrete file list.';

comment on column dev_agent_memory.stage is
  'Which LLM routing stage (operator/planner/worker/validator) produced '
  'this row. Provenance only -- does not restrict which stage may recall '
  'it; a gotcha the worker found is exactly what the planner needs next.';

create index if not exists dev_agent_memory_file_paths_idx
  on dev_agent_memory using gin (file_paths);

-- write_dev_memory(): widened with two new, defaulted, trailing params.
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
  p_supersedes uuid default null,
  p_file_paths text[] default '{}',
  p_stage text default null
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
    file_paths, stage
  ) values (
    p_repo, p_category, p_title, p_content, p_embedding, p_vtid, p_importance, p_source, p_tags,
    p_file_paths, p_stage
  ) returning id into v_id;

  if p_supersedes is not null then
    update dev_agent_memory set superseded_by = v_id where id = p_supersedes;
  end if;

  return v_id;
end;
$$;

comment on function write_dev_memory is
  'VTID-03889 + BOOTSTRAP file-scope wiring: insert one dev_agent_memory '
  'row. embedding must be a real Titan Embeddings G2 vector computed by '
  'the caller -- there is no default and no fallback to a null/zero '
  'vector; the column is NOT NULL. file_paths/stage are optional and '
  'additive.';

-- recall_dev_memory_by_files(): deterministic, file-scoped sibling to
-- recall_dev_memory() (semantic/embedding-based). No embedding call
-- needed -- a caller combines both when the file-scoped result set is
-- thin (e.g. a brand-new file with no history yet).
create or replace function recall_dev_memory_by_files(
  p_repo text,
  p_files text[],
  p_category text default null,
  p_limit int default 8
) returns table (
  id uuid,
  vtid text,
  category text,
  title text,
  content text,
  importance smallint,
  source text,
  tags text[],
  file_paths text[],
  stage text,
  created_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select
    m.id, m.vtid, m.category, m.title, m.content, m.importance, m.source, m.tags,
    m.file_paths, m.stage, m.created_at
  from dev_agent_memory m
  where m.repo = p_repo
    and m.superseded_by is null
    and m.file_paths && p_files
    and (p_category is null or m.category = p_category)
  order by m.importance desc, m.created_at desc
  limit p_limit;
$$;

comment on function recall_dev_memory_by_files is
  'BOOTSTRAP file-scope wiring: recall by concrete changed/target file '
  'overlap (&&), ordered by importance then recency -- deliberately not '
  'a similarity ranking, since there is no query embedding here. Sibling '
  'to recall_dev_memory() (semantic).';

grant execute on function write_dev_memory to service_role;
grant execute on function recall_dev_memory_by_files to service_role;
