-- DIAG: Check if ai_personality_config has overridden voice_live role_descriptions
do $$
declare
  r record;
  cfg jsonb;
begin
  raise notice '=== ai_personality_config rows ===';
  for r in
    select surface_key, is_customized, updated_at,
           jsonb_typeof(config -> 'role_descriptions') as rd_type,
           config -> 'role_descriptions' -> 'community' as comm_desc,
           config -> 'role_descriptions' -> 'admin' as admin_desc
    from public.ai_personality_config
    order by surface_key
  loop
    raise notice '  surface=% customized=% updated=% rd_type=%',
      r.surface_key, r.is_customized, r.updated_at, r.rd_type;
    raise notice '    community="%"', substring(r.comm_desc::text, 1, 200);
    raise notice '    admin="%"',     substring(r.admin_desc::text, 1, 200);
  end loop;
end$$;
