/**
 * VTID-04740 — product_clicks carries referrer_user_id, so a signed-in client
 * must read only its own clicks. The original policy (20260416120000) also
 * exposed every anonymous click (`user_id IS NULL`) to every authenticated
 * user. This pins that the LATEST definition of product_clicks_select_own in
 * the migrations is the caller's own rows only.
 */
import * as fs from 'fs';
import * as path from 'path';

const MIGRATIONS = path.resolve(__dirname, '../../../supabase/migrations');

describe('VTID-04740: product_clicks_select_own is own-rows only', () => {
  it('the latest migration that defines the policy restricts it to user_id = auth.uid()', () => {
    const files = fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort();
    const defining = files.filter((f) =>
      /CREATE POLICY\s+"?product_clicks_select_own"?\s+ON\s+(public\.)?product_clicks/i.test(fs.readFileSync(path.join(MIGRATIONS, f), 'utf8')),
    );
    expect(defining.length).toBeGreaterThan(0);
    const latest = fs.readFileSync(path.join(MIGRATIONS, defining[defining.length - 1]), 'utf8');
    const policy = latest.slice(latest.search(/CREATE POLICY\s+"?product_clicks_select_own/i));
    const using = policy.slice(0, policy.indexOf(';'));
    expect(using).toMatch(/USING\s*\(\s*user_id\s*=\s*auth\.uid\(\)\s*\)/i);
    expect(using).not.toMatch(/IS NULL/i);
  });
});
