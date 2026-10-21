-- VTID-04441 — "do not re-learn" markers for facts a user forgot.
--
-- The Memory Garden (VTID-04388) forgets a fact by deleting every row of its
-- key. Nothing remembered that the user asked for it to be gone, so the next
-- session's extractor could infer the same value again and it reappeared.
--
-- One row per (user, fact_key, value). The value is stored ONLY as a SHA-256
-- of its normalised form (trimmed, lower-cased, whitespace collapsed): the
-- user asked for the value to be forgotten, so the marker must not keep it.
--
-- Enforced in the gateway's single fact write path, rememberFact():
--   - an inferred write (assistant_inferred, behavior_inferred, …) whose
--     key + value hash matches a marker is refused;
--   - an explicit user statement (user_stated*, user_edited) is written and
--     clears the marker — the user has told Vitana again.
--
-- service_role only; no browser access.

create table if not exists public.memory_fact_forgotten (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  user_id uuid not null,
  fact_key text not null,
  value_hash text not null,
  forgotten_at timestamptz not null default now(),
  constraint memory_fact_forgotten_unique unique (tenant_id, user_id, fact_key, value_hash)
);

create index if not exists memory_fact_forgotten_user_key_idx
  on public.memory_fact_forgotten (user_id, fact_key);

alter table public.memory_fact_forgotten enable row level security;

revoke all on public.memory_fact_forgotten from public, anon, authenticated;
grant select, insert, delete on public.memory_fact_forgotten to service_role;

comment on table public.memory_fact_forgotten is
  'VTID-04441: facts a user forgot in the Memory Garden. value_hash = sha256 of the normalised value; the value itself is not kept. Inferred re-writes of the same key+value are refused by rememberFact().';
