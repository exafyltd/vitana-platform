/**
 * VTID-04489 — contract of get_index_boost (the profile card's "Biggest
 * boost" line). Pins the owner's visibility decision (public by default,
 * member can opt out), the signed-in-only grant, and the ranking rule that
 * a pillar which fell never outranks more activity.
 */
import * as fs from 'fs';
import * as path from 'path';

jest.mock('../src/lib/supabase', () => ({ getSupabase: jest.fn() }));

import { FIELD_DEFAULTS } from '../src/lib/account-visibility';

const sql = fs.readFileSync(
  path.resolve(__dirname, '../../../supabase/migrations/20260924170000_vtid_04489_index_boost.sql'),
  'utf8',
);

describe('VTID-04489 index boost', () => {
  it('is public by default and the member can hide it', () => {
    expect(FIELD_DEFAULTS.indexBoost).toBe('public');
    expect(sql).toContain("coalesce(p.account_visibility->>'indexBoost', 'public')");
    expect(sql).toMatch(/IF v_vis = 'private'/);
    expect(sql).toContain("RETURN jsonb_build_object('hidden', true);");
  });

  it('is callable by signed-in members only', () => {
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.get_index_boost\(uuid\) FROM anon;/);
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.get_index_boost\(uuid\) TO authenticated;/);
    expect(sql).toMatch(/IF p_user_id IS NULL OR v_viewer IS NULL THEN\s+RETURN NULL;/);
  });

  it('ranks rising pillars first, then by activity count', () => {
    expect(sql).toContain('CASE WHEN d.delta > 0 THEN d.delta END DESC NULLS LAST');
    expect(sql).not.toContain('coalesce(d.delta, 0) DESC, c.n DESC');
  });

  it('reads only the subject\'s own rows', () => {
    expect(sql).toContain('WHERE user_id = p_user_id AND date > current_date - v_window');
    expect(sql).toContain('WHERE j.user_id = p_user_id');
  });
});
