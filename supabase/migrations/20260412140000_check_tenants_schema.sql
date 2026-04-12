SELECT column_name, data_type FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'tenants'
ORDER BY ordinal_position LIMIT 10;

SELECT column_name, data_type FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'app_users'
ORDER BY ordinal_position LIMIT 10;
