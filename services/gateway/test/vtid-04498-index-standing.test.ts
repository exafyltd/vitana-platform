/**
 * VTID-04498 — contract of get_index_standing (the profile card's real
 * "Top X%" badge). Pins the rules that keep the badge honest: a minimum
 * cohort, no badge when nobody scores lower (48 of 66 members were tied at
 * the starting score on 2026-09-24), top half only, service/test accounts
 * excluded, signed-in callers only.
 */
import * as fs from 'fs';
import * as path from 'path';

const sql = fs.readFileSync(
  path.resolve(__dirname, '../../../supabase/migrations/20260924190000_vtid_04498_index_standing.sql'),
  'utf8',
);

describe('VTID-04498 index standing', () => {
  it('needs at least 20 members before any rank is shown', () => {
    expect(sql).toContain('c_min_cohort        CONSTANT integer := 20;');
    expect(sql).toMatch(/IF v_cohort < c_min_cohort THEN\s+RETURN jsonb_build_object\('show', false, 'reason', 'cohort_too_small'/);
  });

  it('shows nothing when no member scores lower (tied at the floor)', () => {
    expect(sql).toContain("count(*) FILTER (WHERE l.score_total < v_score)");
    expect(sql).toMatch(/IF v_lower = 0 THEN\s+RETURN jsonb_build_object\('show', false, 'reason', 'no_one_below'/);
  });

  it('shows the badge only in the top half', () => {
    expect(sql).toContain('c_max_badge_percent CONSTANT integer := 50;');
    expect(sql).toMatch(/IF v_top > c_max_badge_percent THEN\s+RETURN jsonb_build_object\('show', false, 'reason', 'not_top_half'/);
  });

  it('returns a percentage only when show is true', () => {
    const withPercent = sql.match(/jsonb_build_object\([^;]*'top_percent'[^;]*\)/g) ?? [];
    expect(withPercent).toHaveLength(1);
    expect(withPercent[0]).toContain("'show', true");
  });

  it('excludes service and test accounts from the cohort (platform rule 45)', () => {
    expect(sql).toContain('public.service_bot_accounts b WHERE b.user_id = l.user_id');
    expect(sql).toContain('public.notification_test_actors a WHERE a.user_id = l.user_id');
  });

  it('is callable by signed-in members only', () => {
    expect(sql).toMatch(/IF p_user_id IS NULL OR v_viewer IS NULL THEN\s+RETURN NULL;/);
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.get_index_standing\(uuid\) FROM anon;/);
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.get_index_standing\(uuid\) TO authenticated;/);
  });
});
