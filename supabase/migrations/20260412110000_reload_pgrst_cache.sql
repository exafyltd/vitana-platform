-- Reload PostgREST schema cache so newly created tables are visible
NOTIFY pgrst, 'reload schema';
