/**
 * Synthetic test personas for the universal agent testing capability.
 *
 * A persona is a recognisable, non-deliverable test user. Agents never own a persona; they are
 * issued a short-lived session *as* one, and every row the session writes is tagged with the
 * agent and session that wrote it (see broker.ts). Personas are data, so adding one does not
 * need a code change to the broker.
 *
 * Hard rules (enforced in broker.ts, not by convention here):
 *  - email is always on the reserved `.invalid` TLD: it can never be delivered to a real person;
 *  - `is_test` is always true;
 *  - a persona is only ever provisioned in the staging environment (see environment.ts).
 */

export type PersonaKey = 'community_member' | 'community_member_b' | 'community_admin' | 'no_permission';

export interface Persona {
  key: PersonaKey;
  display_name: string;
  email: string;
  /** Coarse role the app's own permission checks see. */
  app_role: 'member' | 'admin' | 'none';
  /** Permissions the persona is meant to hold, used to assert what it must and must not reach. */
  grants: readonly string[];
  is_test: true;
}

export const PERSONAS: Readonly<Record<PersonaKey, Persona>> = Object.freeze({
  community_member: {
    key: 'community_member',
    display_name: 'Test Member A',
    email: 'test-member-a@test.vitana.invalid',
    app_role: 'member',
    grants: ['community:read', 'profile:own:write', 'diary:own:write'],
    is_test: true,
  },
  community_member_b: {
    key: 'community_member_b',
    display_name: 'Test Member B',
    email: 'test-member-b@test.vitana.invalid',
    app_role: 'member',
    grants: ['community:read', 'profile:own:write'],
    is_test: true,
  },
  community_admin: {
    key: 'community_admin',
    display_name: 'Test Admin',
    email: 'test-admin@test.vitana.invalid',
    app_role: 'admin',
    grants: ['community:read', 'admin:read'],
    is_test: true,
  },
  no_permission: {
    key: 'no_permission',
    display_name: 'Test No-Permission User',
    email: 'test-none@test.vitana.invalid',
    app_role: 'none',
    grants: [],
    is_test: true,
  },
});

/** Every persona must be on the reserved test TLD and flagged as a test identity. */
export function validatePersonas(personas: Readonly<Record<string, Persona>> = PERSONAS): string[] {
  const problems: string[] = [];
  for (const p of Object.values(personas)) {
    if (!p.email.endsWith('.test.vitana.invalid') && !p.email.endsWith('.invalid')) problems.push(`${p.key}: email not on reserved .invalid TLD`);
    if (p.is_test !== true) problems.push(`${p.key}: is_test must be true`);
  }
  return problems;
}
