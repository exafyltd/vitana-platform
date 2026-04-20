-- DIAG: Surface the state of ai_provider_policies + tenants so we can see
-- why PROVIDER_NOT_ALLOWED_FOR_TENANT is still firing after the seed
-- migration at 20260420140000 ran.
--
-- This file does NOT modify data. It only runs SELECTs via RAISE NOTICE so
-- the output appears in the RUN-MIGRATION workflow logs.

do $$
declare
  tenant_count int;
  policy_count int;
  claude_count int;
  chatgpt_count int;
  orphaned_user_tenants int;
  sample_tenant record;
  sample_policy record;
begin
  select count(*) into tenant_count from public.tenants;
  raise notice '--- tenants count: %', tenant_count;

  select count(*) into policy_count from public.ai_provider_policies;
  raise notice '--- ai_provider_policies total rows: %', policy_count;

  select count(*) into claude_count
    from public.ai_provider_policies where provider = 'claude' and allowed = true;
  raise notice '--- ai_provider_policies claude+allowed rows: %', claude_count;

  select count(*) into chatgpt_count
    from public.ai_provider_policies where provider = 'chatgpt' and allowed = true;
  raise notice '--- ai_provider_policies chatgpt+allowed rows: %', chatgpt_count;

  -- How many user_tenants point at a tenant_id that doesn't exist in public.tenants?
  select count(*) into orphaned_user_tenants
    from public.user_tenants ut
    left join public.tenants t on t.id = ut.tenant_id
    where t.id is null;
  raise notice '--- user_tenants with tenant_id NOT in public.tenants: %', orphaned_user_tenants;

  -- Sample: first 3 tenants
  for sample_tenant in
    select id, slug, name from public.tenants order by created_at asc limit 3
  loop
    raise notice '--- sample tenant: id=% slug=% name=%', sample_tenant.id, sample_tenant.slug, sample_tenant.name;
  end loop;

  -- Sample: first 5 policy rows
  for sample_policy in
    select tenant_id, provider, allowed from public.ai_provider_policies limit 5
  loop
    raise notice '--- sample policy: tenant_id=% provider=% allowed=%',
      sample_policy.tenant_id, sample_policy.provider, sample_policy.allowed;
  end loop;

  -- If there are orphaned user_tenants rows, show a few — likely the root cause.
  if orphaned_user_tenants > 0 then
    for sample_tenant in
      select distinct ut.tenant_id
      from public.user_tenants ut
      left join public.tenants t on t.id = ut.tenant_id
      where t.id is null
      limit 5
    loop
      raise notice '--- orphaned tenant_id from user_tenants (no match in tenants): %', sample_tenant.tenant_id;
    end loop;
  end if;
end$$;
