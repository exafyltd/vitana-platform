/**
 * VTID-04783 — Discover categories as data, and supplier products mapped onto
 * them. Pins the parts of the migration a later edit could silently break.
 * The behaviour itself ran against a real Postgres 16:
 * docs/validation/VTID-04783/migration-scenarios.sql (15 scenarios, output in
 * docs/validation/VTID-04783/outputs/).
 */
import * as fs from 'fs';
import * as path from 'path';

const sql = fs.readFileSync(
  path.resolve(__dirname, '../../../supabase/migrations/20261001140000_vtid_04783_discover_categories.sql'),
  'utf8',
);

function fnBody(name: string): string {
  const start = sql.indexOf(`FUNCTION public.${name}(`);
  expect(start).toBeGreaterThan(-1);
  const open = sql.indexOf('$$', start);
  return sql.slice(open + 2, sql.indexOf('$$', open + 2));
}

describe('VTID-04783: Discover categories migration', () => {
  it('keeps the three categories Discover already shows and their subcategory i18n keys', () => {
    for (const k of ["'supplements'", "'skincare'", "'health-tests'"]) expect(sql).toContain(`(${k},`);
    expect(sql).toContain("('skincare',    'face-care',             'discover.subcategories.faceCare'");
    expect(sql).toContain("('health-tests','dna-analysis',          'discover.subcategories.dnaAnalysis'");
  });

  it('stores labels as i18n keys, never display text', () => {
    const labels = [...sql.matchAll(/'(discover\.[A-Za-z.]+)'/g)].map((m) => m[1]);
    expect(labels.length).toBeGreaterThan(30);
    expect(sql).not.toMatch(/label\s+TEXT/i);
  });

  it('maps the owner-approved verticals, services left for step C', () => {
    for (const [v, c] of [
      ['supplements', 'supplements'], ['diagnostics', 'health-tests'], ['beauty_care', 'skincare'],
      ['fitness_equipment', 'fitness'], ['apparel', 'apparel'], ['devices_wearables', 'devices'],
      ['home_living', 'home'], ['wine_spirits', 'drinks'], ['other', 'lifestyle'],
    ]) {
      expect(sql).toMatch(new RegExp(`\\('${v}',\\s+'${c}'\\)`));
    }
    expect(sql).not.toMatch(/\('services',\s+'/);
  });

  it('only touches supplier products; network products are left alone', () => {
    const body = fnBody('trg_products_discover_category');
    expect(body).toMatch(/m\.partner_organization_id IS NOT NULL OR m\.owner_user_id IS NOT NULL/);
    expect(body).toMatch(/IF NOT COALESCE\(v_supplier, FALSE\) THEN\s+RETURN NEW;/);
  });

  it('keeps a subcategory only when it belongs to the product category, never hiding the product', () => {
    const body = fnBody('trg_products_discover_category');
    expect(body).toMatch(/WHERE category_key = NEW\.category AND key = NEW\.subcategory AND is_active/);
    expect(body).toMatch(/NEW\.subcategory := NULL;/);
    expect(body).not.toMatch(/is_active\s*:=/);
  });

  it('counts only active products in known categories', () => {
    const body = fnBody('discover_category_counts');
    expect(body).toMatch(/JOIN discover_categories c ON c\.key = p\.category AND c\.is_active/);
    expect(body).toMatch(/WHERE p\.is_active/);
  });

  it('lets anyone read the catalogue metadata, only the service role write it', () => {
    expect(sql).toMatch(/GRANT SELECT ON public\.discover_categories, public\.discover_subcategories TO anon, authenticated;/);
    expect(sql).toMatch(/FOR SELECT USING \(true\)/);
    expect(sql).not.toMatch(/FOR (INSERT|UPDATE|DELETE|ALL)/);
  });
});
