/**
 * VTID-05038 — "Alle Beisammen" auto-enrollment.
 *
 * 1. Drift guard: the latest migration that (re)defines
 *    fire_welcome_chat_on_membership() must keep the Alle Beisammen shape —
 *    the account guard first (both allowlists), enrollment before both early
 *    returns, a metadata-driven cap — and the welcome DM unchanged.
 *    20260917084341_vtid_03990 re-created the function from an old body and
 *    silently dropped all of that; this test makes the next such regression
 *    fail CI.
 * 2. The login-time path (addUserToSystemGroups) skips registered
 *    service/test accounts and fails closed when the allowlists can't be read.
 */
import * as fs from 'fs';
import * as path from 'path';

const mockStrict = jest.fn();
jest.mock('../src/lib/excluded-test-service-accounts', () => ({
  fetchExcludedTestServiceAccountIdsStrict: (...a: unknown[]) => mockStrict(...a),
}));
const mockGroups = jest.fn();
const mockExisting = jest.fn();
const mockCount = jest.fn();
const mockInsert = jest.fn();
jest.mock('../src/services/community-group-enrollment-repository', () => ({
  fetchSystemChatGroups: (...a: unknown[]) => mockGroups(...a),
  fetchExistingGroupMembership: (...a: unknown[]) => mockExisting(...a),
  countGroupMembers: (...a: unknown[]) => mockCount(...a),
  insertGroupMembership: (...a: unknown[]) => mockInsert(...a),
}));

import { addUserToSystemGroups } from '../src/services/community-group-enrollment';

const MIGRATIONS = path.join(__dirname, '../../../supabase/migrations');

function latestFunctionBody(): { file: string; body: string } {
  const files = fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort().reverse();
  for (const f of files) {
    const sql = fs.readFileSync(path.join(MIGRATIONS, f), 'utf8');
    const m = sql.match(/CREATE OR REPLACE FUNCTION public\.fire_welcome_chat_on_membership\(\)[\s\S]*?\$fn\$([\s\S]*?)\$fn\$/);
    if (m) return { file: f, body: m[1].replace(/--.*$/gm, '') };
  }
  throw new Error('no migration defines fire_welcome_chat_on_membership');
}

describe('VTID-05038: welcome trigger keeps the Alle Beisammen shape (drift guard)', () => {
  const { file, body } = latestFunctionBody();
  const at = (needle: string) => {
    const i = body.indexOf(needle);
    if (i < 0) throw new Error(`${file}: "${needle}" not found in fire_welcome_chat_on_membership()`);
    return i;
  };

  it('guards both allowlists before anything else touches chat or groups', () => {
    const guard = at('notification_test_actors');
    expect(at('service_bot_accounts')).toBeLessThan(at('INSERT INTO public.chat_group_members'));
    expect(guard).toBeLessThan(at('INSERT INTO public.chat_group_members'));
    expect(guard).toBeLessThan(at('INSERT INTO public.chat_messages'));
  });

  it('enrolls before the welcome_chat_sent and > 1000 early returns', () => {
    const enroll = at('INSERT INTO public.chat_group_members');
    expect(enroll).toBeLessThan(at('IF v_app_user.welcome_chat_sent THEN'));
    expect(enroll).toBeLessThan(at('v_recipient > 1000'));
  });

  it('reads the cap from metadata (NULL = uncapped), never a hard-coded 100', () => {
    expect(body).toContain("(g.metadata->>'cap') IS NULL");
    expect(body).toContain("< (g.metadata->>'cap')::int");
    expect(body).not.toMatch(/<\s*100\b/);
  });

  it('leaves the welcome DM text unchanged', () => {
    expect(body).toContain("v_message := 'Hello! My name is ' || v_display_name");
    expect(body).toContain("' — I just joined the community and I''m excited to connect with you! 🙌'");
  });
});

describe('VTID-05038: login-time enrollment skips service/test accounts', () => {
  const sb = {} as never;
  beforeEach(() => {
    jest.clearAllMocks();
    mockGroups.mockResolvedValue({ data: [{ id: 'g-all', name: 'Alle Beisammen', metadata: { cap: null } }], error: null });
    mockExisting.mockResolvedValue({ data: null });
    mockInsert.mockResolvedValue({ error: null });
  });

  it('enrolls a real member', async () => {
    mockStrict.mockResolvedValue({ ok: true, ids: new Set(['bot-1']) });
    const r = await addUserToSystemGroups('member-1', 't1', sb);
    expect(r.added).toEqual(['g-all']);
    expect(mockInsert).toHaveBeenCalledTimes(1);
  });

  it('never enrolls a registered service/test account', async () => {
    mockStrict.mockResolvedValue({ ok: true, ids: new Set(['bot-1']) });
    const r = await addUserToSystemGroups('bot-1', 't1', sb);
    expect(r).toEqual({ added: [], skipped: [{ group_id: '*', reason: 'excluded_account' }] });
    expect(mockGroups).not.toHaveBeenCalled();
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('fails closed when the allowlists cannot be read', async () => {
    mockStrict.mockResolvedValue({ ok: false, error: 'boom' });
    const r = await addUserToSystemGroups('member-1', 't1', sb);
    expect(r).toEqual({ added: [], skipped: [{ group_id: '*', reason: 'exclusion_lookup_failed' }] });
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('still respects a numeric cap', async () => {
    mockStrict.mockResolvedValue({ ok: true, ids: new Set() });
    mockGroups.mockResolvedValue({ data: [{ id: 'g-100', name: 'FIRST 100', metadata: { cap: 100 } }], error: null });
    mockCount.mockResolvedValue({ count: 100, error: null });
    const r = await addUserToSystemGroups('member-1', 't1', sb);
    expect(r.skipped).toEqual([{ group_id: 'g-100', reason: 'cap_reached' }]);
    expect(mockInsert).not.toHaveBeenCalled();
  });
});
