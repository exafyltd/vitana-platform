/**
 * VTID-04769 — a supplier that goes live appears on Discover.
 *
 * The behaviour lives in one migration (triggers on partner_organizations,
 * merchants, products and the two test/service-account registries), because
 * every member-facing reader — Discover feed, search, product page, the ORB
 * marketplace tools, checkout — already filters on products.is_active. This
 * pins the parts of that migration a later edit could silently break:
 *
 *   - only supplier merchants are gated; network products are never touched
 *   - both exclusion registries are honoured (platform CLAUDE.md rules 43-45)
 *   - the gate's own writes are told apart from an admin's decision
 *   - an admin switch-off is never undone by a go-live
 *
 * The full behaviour was run against a real Postgres 16 with
 * docs/validation/VTID-04769/migration-scenarios.sql (41 scenarios, output in
 * docs/validation/VTID-04769/outputs/).
 */
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../../..');
const MIGRATION = path.join(
  ROOT,
  'supabase/migrations/20261001120000_vtid_04769_supplier_go_live_lists_products.sql',
);
const sql = fs.readFileSync(MIGRATION, 'utf8');

function fnBody(name: string): string {
  const start = sql.indexOf(`FUNCTION public.${name}(`);
  expect(start).toBeGreaterThan(-1);
  const open = sql.indexOf('$$', start);
  const close = sql.indexOf('$$', open + 2);
  return sql.slice(open + 2, close);
}

describe('VTID-04769: supplier go-live lists products on Discover', () => {
  it('gates only supplier merchants: no org and no owner means untouched (network products)', () => {
    const body = fnBody('supplier_listing_block');
    expect(body).toMatch(/IF v_org_id IS NULL THEN\s+RETURN NULL;/);
    expect(body).toMatch(/IF NOT FOUND THEN\s+RETURN NULL;/);
    // The backfill only walks supplier merchants.
    expect(sql).toMatch(/FROM public\.merchants WHERE partner_organization_id IS NOT NULL OR owner_user_id IS NOT NULL/);
  });

  it('only a live org is eligible', () => {
    expect(fnBody('supplier_listing_block')).toMatch(/IF v_lifecycle IS DISTINCT FROM 'live' THEN\s+RETURN 'org_not_live';/);
  });

  it('never lists test or service accounts, checked before eligibility', () => {
    const body = fnBody('supplier_listing_block');
    const excluded = body.indexOf("RETURN 'excluded_account'");
    expect(body).toContain('FROM service_bot_accounts');
    expect(body).toContain('FROM notification_test_actors');
    expect(excluded).toBeGreaterThan(-1);
    expect(excluded).toBeLessThan(body.indexOf("RETURN 'eligible'"));
    // Registering an account later takes its products down at once.
    expect(sql).toMatch(/AFTER INSERT OR DELETE ON public\.service_bot_accounts/);
    expect(sql).toMatch(/AFTER INSERT OR DELETE ON public\.notification_test_actors/);
  });

  it('go-live switches on only waiting products, never one an admin switched off', () => {
    const body = fnBody('refresh_supplier_listings');
    expect(body).toMatch(/AND is_active = FALSE\s+AND \(listing_hold IS NOT NULL OR first_listed_at IS NULL\)/);
  });

  it("marks the refresh's own writes so the product trigger does not read them as an admin decision", () => {
    const refresh = fnBody('refresh_supplier_listings');
    expect(refresh).toContain("set_config('vitana.supplier_gate_refresh', 'on', true)");
    expect(refresh).toContain("set_config('vitana.supplier_gate_refresh', 'off', true)");
    expect(fnBody('trg_products_supplier_gate')).toContain("current_setting('vitana.supplier_gate_refresh', true) = 'on'");
  });

  it('an explicit switch-off clears the hold, so the product stays off after go-live', () => {
    const body = fnBody('trg_products_supplier_gate');
    const off = body.slice(body.lastIndexOf('ELSE'));
    expect(off).toMatch(/NEW\.listing_hold := NULL;/);
    expect(off).toMatch(/NEW\.first_listed_at := COALESCE\(NEW\.first_listed_at, now\(\)\);/);
  });

  it('reacts to go-live, pause and suspend, including the legacy /activate status write', () => {
    expect(sql).toMatch(/AFTER UPDATE ON public\.partner_organizations/);
    expect(fnBody('trg_partner_org_refresh_listings')).toContain('NEW.lifecycle_state IS NOT DISTINCT FROM OLD.lifecycle_state');
  });

  it('links a hand-added merchant to its owner only when it is unambiguous', () => {
    const body = fnBody('sole_owned_partner_org');
    expect(body).toMatch(/CASE WHEN count\(\*\) = 1 THEN/);
    expect(body).toMatch(/NOT EXISTS \(SELECT 1 FROM merchants m WHERE m\.partner_organization_id = o\.id\)/);
    expect(sql).toMatch(/BEFORE INSERT ON public\.merchants/);
    expect(sql).toMatch(/AFTER INSERT ON public\.partner_organizations/);
  });

  it('keeps the helpers off the member-facing API', () => {
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.supplier_listing_block\(UUID\) FROM PUBLIC, anon, authenticated;/);
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.refresh_supplier_listings\(UUID\) FROM PUBLIC, anon, authenticated;/);
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.sole_owned_partner_org\(UUID\) FROM PUBLIC, anon, authenticated;/);
  });
});
