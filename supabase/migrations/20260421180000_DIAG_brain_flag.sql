-- Check if useOrbBrain is enabled in system_controls (which would route the
-- orb through buildBrainSystemInstruction instead of buildLiveSystemInstruction)
do $$
declare
  r record;
begin
  raise notice '=== system_controls for vitana_brain_* ===';
  for r in
    select key, enabled, payload, updated_at
    from public.system_controls
    where key ilike 'vitana_brain%'
    order by key
  loop
    raise notice '  key=% enabled=% payload=% updated=%',
      r.key, r.enabled, r.payload::text, r.updated_at;
  end loop;
end$$;
