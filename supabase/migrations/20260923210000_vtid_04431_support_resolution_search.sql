-- VTID-04431 — staff-side recall over resolved-ticket memory.
--
-- VTID-04412 writes a role:support copy of every resolved ticket into
-- memory_items (category 'support_ticket', active_role 'support'). Nothing
-- read it: memory_semantic_search is scoped to ONE user, and the support
-- copies belong to many members. This function searches them across members
-- of ONE tenant and returns only the ticket ids and similarity — never the
-- episode text — so the caller loads the published resolution from
-- feedback_tickets and can never echo another member's report.
--
-- service_role only. Read-only. Callers: the Sage answer drafter and the
-- Devon spec drafter (drafts are always human-reviewed before a member sees
-- anything).

create or replace function public.support_resolution_search(
  p_query_embedding vector,
  p_tenant_id uuid,
  p_top_k integer default 3,
  p_exclude_ticket_id text default null,
  p_min_similarity double precision default 0.35
)
returns table (ticket_id text, similarity double precision, occurred_at timestamptz)
language sql
stable
set search_path to 'public'
as $$
  select mi.content_json->>'ticket_id' as ticket_id,
         (1 - (mi.embedding <=> p_query_embedding))::float8 as similarity,
         mi.occurred_at
  from public.memory_items mi
  where p_tenant_id is not null
    and mi.tenant_id = p_tenant_id
    and mi.category_key = 'support_ticket'
    and mi.active_role = 'support'
    and mi.embedding is not null
    and (p_exclude_ticket_id is null or mi.content_json->>'ticket_id' is distinct from p_exclude_ticket_id)
    and (1 - (mi.embedding <=> p_query_embedding)) >= p_min_similarity
  order by mi.embedding <=> p_query_embedding
  limit least(greatest(coalesce(p_top_k, 3), 1), 10);
$$;

revoke all on function public.support_resolution_search(vector, uuid, integer, text, double precision) from public, anon, authenticated;
grant execute on function public.support_resolution_search(vector, uuid, integer, text, double precision) to service_role;

comment on function public.support_resolution_search(vector, uuid, integer, text, double precision) is
  'VTID-04431: similar resolved tickets (role:support episodes) within one tenant; returns ticket ids only. service_role only.';
