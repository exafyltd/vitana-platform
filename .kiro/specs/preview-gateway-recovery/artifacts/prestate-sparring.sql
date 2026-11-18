-- prestate-sparring.sql — READ-ONLY. One line, `created_roles|revoke_memberships|revoke_usage`, recorded by
-- restore-sparring-schema.sh --apply BEFORE anything is applied (restore-sparring-state.json) and replayed by --rollback:
--   created_roles       restore roles absent before the restore (only these are ever dropped)
--   revoke_memberships  request roles authenticator was NOT a direct member of before (only these are revoked)
--   revoke_usage        request roles with no explicit USAGE entry on schema public before (only these are revoked)
SELECT
  coalesce((SELECT string_agg(n, ',' ORDER BY n) FROM unnest(ARRAY['anon','authenticated','service_role','vitana_governance_owner']) n
            WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = n)), '')
  || '|' ||
  coalesce((SELECT string_agg(n, ',' ORDER BY n) FROM unnest(ARRAY['anon','authenticated','service_role']) n
            WHERE NOT EXISTS (SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.roleid JOIN pg_roles u ON u.oid = m.member
                              WHERE r.rolname = n AND u.rolname = 'authenticator')), '')
  || '|' ||
  coalesce((SELECT string_agg(n, ',' ORDER BY n) FROM unnest(ARRAY['anon','authenticated','service_role']) n
            WHERE NOT EXISTS (SELECT 1 FROM pg_namespace ns CROSS JOIN LATERAL aclexplode(ns.nspacl) a JOIN pg_roles r ON r.oid = a.grantee
                              WHERE ns.nspname = 'public' AND r.rolname = n AND a.privilege_type = 'USAGE')), '');
