/**
 * No-account-market guard (runbook Sec. 0.3 item 5, Sec. 3, Sec. 10).
 *
 * No model/endpoint/UI may implement account transfer/sale/inventory-pool
 * semantics, or loyalty-point pooling/resale/brokerage. This decision is baked in
 * (Sec. 10) and CUT from scope. This guard rejects any route/action name or schema
 * that expresses those semantics.
 */
import { AccountMarketViolation } from './errors';

/** Semantic fragments that describe an account/points marketplace. */
const FORBIDDEN_SEMANTICS = [
  'account_transfer',
  'account_sale',
  'account_sell',
  'account_buy',
  'account_marketplace',
  'account_inventory',
  'sell_account',
  'buy_account',
  'transfer_account',
  'points_pool',
  'point_pool',
  'pool_points',
  'points_resale',
  'resell_points',
  'resale_points',
  'broker_points',
  'points_broker',
  'points_transfer',
  'transfer_points',
  'miles_pool',
  'miles_transfer',
  'loyalty_marketplace',
  'inventory_pool',
];

function normalize(name: string): string {
  return (name ?? '').toLowerCase().replace(/[-\s/]+/g, '_');
}

/**
 * Throw if a route path / action / endpoint name expresses account-market or
 * points-pooling semantics. Wire over the VCAOP route table and connector actions.
 */
export function assertNoAccountMarketSemantics(name: string): void {
  const n = normalize(name);
  for (const frag of FORBIDDEN_SEMANTICS) {
    if (n.includes(frag)) {
      throw new AccountMarketViolation(
        `Refused: "${name}" expresses account/points-market semantics ("${frag}") — CUT by decision (Sec. 10)`,
      );
    }
  }
}

/**
 * Assert a set of route definitions contains no account-market endpoints.
 * Convenience for wiring over an Express route registry at boot.
 */
export function assertRoutesClean(routePaths: Iterable<string>): void {
  for (const p of routePaths) assertNoAccountMarketSemantics(p);
}
