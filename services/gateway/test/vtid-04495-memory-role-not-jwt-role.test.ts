/**
 * VTID-04495: the Supabase JWT `role` claim ('authenticated') is never a
 * memory role. Found live on staging: an ORB navigation note was stored with
 * active_role='authenticated', which hid it from the user's personal memory.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { memoryRoleForWrite, memoryRoleForRead, memoryRoleOrFilter } from '../src/services/memory/scope';
import { recallOrbMemoryItems } from '../src/services/memory/recall';

describe('VTID-04495 database roles are not memory roles', () => {
  it.each(['authenticated', 'anon', 'service_role', 'supabase_admin', ' Authenticated '])(
    '%s is stored as personal memory and read as community',
    (r) => {
      expect(memoryRoleForWrite(r)).toBeNull();
      expect(memoryRoleForRead(r)).toBe('community');
      expect(memoryRoleOrFilter(r)).toBe('active_role.is.null,active_role.eq.community');
    },
  );

  it('real work roles still scope the row', () => {
    for (const r of ['developer', 'backoffice', 'support', 'admin', 'staff']) {
      expect(memoryRoleForWrite(r)).toBe(r);
    }
    expect(memoryRoleForWrite('community')).toBeNull();
    expect(memoryRoleForWrite(null)).toBeNull();
  });

  it('recall sends no role or lens for the JWT role', async () => {
    const read = jest.fn(async () => ({ ok: false, error: 'x' }));
    await recallOrbMemoryItems({ user_id: 'u', tenant_id: 't', active_role: 'authenticated' }, { read: read as any });
    const input = (read.mock.calls[0] as any[])[0];
    expect(input.role).toBeUndefined();
    expect(input.lens).toBeUndefined();
  });

  it('the ORB turn writers no longer fall back to identity.role', () => {
    const src = readFileSync(
      join(__dirname, '../src/orb/live/session/upstream-message-handler.ts'), 'utf8');
    expect(src).not.toMatch(/active_role:\s*session\.active_role\s*\|\|\s*session\.identity\.role/);
    expect(src.match(/VTID-04495: never the JWT role claim/g)?.length).toBe(2);
  });
});
