/**
 * VTID-04483 — contract of the profile health summary.
 *
 * The data itself lives in SQL (get_profile_health_summary), so this pins the
 * two things a later edit could quietly break: the gateway's visibility
 * default for the new `vitanaHealth` key stays private (it mirrors the
 * frontend map), and the migration keeps its privacy and honesty rules.
 */
import * as fs from 'fs';
import * as path from 'path';

jest.mock('../src/lib/supabase', () => ({ getSupabase: jest.fn() }));

import { FIELD_DEFAULTS } from '../src/lib/account-visibility';

const MIGRATION = path.resolve(
  __dirname,
  '../../../supabase/migrations/20260924150000_vtid_04483_profile_health_summary.sql',
);
const sql = fs.readFileSync(MIGRATION, 'utf8');

describe('VTID-04483 profile health summary', () => {
  it('health sharing is private by default', () => {
    expect(FIELD_DEFAULTS.vitanaHealth).toBe('private');
  });

  it('is callable by signed-in members only', () => {
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.get_profile_health_summary\(uuid\) FROM anon;/);
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.get_profile_health_summary\(uuid\) FROM PUBLIC;/);
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.get_profile_health_summary\(uuid\) TO authenticated;/);
    expect(sql).toMatch(/IF p_user_id IS NULL OR v_viewer IS NULL THEN\s+RETURN NULL;/);
  });

  it('treats a missing consent as private', () => {
    expect(sql).toContain("coalesce(p.account_visibility->>'vitanaHealth', 'private')");
  });

  it('never compares below the minimum cohort and never counts test/service accounts', () => {
    expect(sql).toMatch(/c_min_cohort\s+CONSTANT integer := 20;/);
    expect(sql).toContain('IF v_cohort + 1 >= c_min_cohort THEN');
    expect(sql).toContain('FROM public.service_bot_accounts b');
    expect(sql).toContain('FROM public.notification_test_actors a');
  });

  it('keeps activity logs owner-only and pillars behind consent', () => {
    const activity = sql.indexOf('FROM public.health_features_daily h');
    const ownerGate = sql.lastIndexOf('IF v_is_owner THEN', activity);
    expect(activity).toBeGreaterThan(-1);
    expect(ownerGate).toBeGreaterThan(-1);
    const pillars = sql.indexOf("v_pillars := jsonb_build_object(");
    expect(sql.lastIndexOf('IF v_shared THEN', pillars)).toBeGreaterThan(-1);
  });
});
