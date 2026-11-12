// VTID-05520: the synthetic identities of supabase/tests/fixtures/*.sql, in one place for the suites.
// Every value here is made up; none belongs to a real tenant or user (fixtures.test.mjs checks they match the SQL).
export const T_A = 'aaaaaaaa-0000-4000-8000-00000000000a';
export const T_B = 'bbbbbbbb-0000-4000-8000-00000000000b';
export const USERS = {
  a_member: '0000000a-0000-4000-8000-000000000001',
  a_admin: '0000000a-0000-4000-8000-000000000002',
  b_member: '0000000b-0000-4000-8000-000000000001',
  b_admin: '0000000b-0000-4000-8000-000000000002',
  ab_dual: '0000000c-0000-4000-8000-000000000001',
};
export const CANARY_A_RE = /^CANARY_A_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
