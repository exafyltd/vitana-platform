/**
 * VTID-03894 — the guard on a money path.
 *
 * `checkout-service.ts` routes a cart line by `products.source_network`. A line
 * whose network is in FIRST_PARTY_SOURCE_NETWORKS debits the BUYER'S WALLET and
 * writes a CONVERTED order meaning "Vitana fulfils". Everything else clicks out.
 *
 * A self-registered supplier's product is emphatically the second kind: it
 * carries an affiliate_url to their own shop, and nothing here pays a supplier
 * or tells them to ship. If SUPPLIER_SOURCE_NETWORK ever lands in that set, the
 * first approved supplier product silently takes a member's money for an order
 * that will never be fulfilled — with no error, no log, and no test failing.
 *
 * That is precisely the bug this file exists to make impossible. It was real:
 * the route originally wrote 'manual', which IS first-party.
 */
// describe/it/expect come from Jest's globals — the gateway runs Jest (ts-jest),
// not Vitest, and no sibling suite in this tree imports them.
import { FIRST_PARTY_SOURCE_NETWORKS } from '../../src/services/checkout/checkout-service';
import { SUPPLIER_SOURCE_NETWORK } from '../../src/routes/vcaop-portal-my-products';

describe('supplier products must never settle from a member wallet', () => {
  it('SUPPLIER_SOURCE_NETWORK is not first-party', () => {
    expect(FIRST_PARTY_SOURCE_NETWORKS.has(SUPPLIER_SOURCE_NETWORK)).toBe(false);
  });

  it('is not the value the route used to write', () => {
    // 'manual' is in the first-party set. Reverting to it would reintroduce
    // the exact defect, so the old literal is called out by name.
    expect(SUPPLIER_SOURCE_NETWORK).not.toBe('manual');
    expect(FIRST_PARTY_SOURCE_NETWORKS.has('manual')).toBe(true);
  });

  it('pins the first-party set, so widening it is a deliberate, visible act', () => {
    // Adding a network here changes where real money goes. If this assertion
    // fails, the change wanted review — it did not want a quick update.
    expect([...FIRST_PARTY_SOURCE_NETWORKS].sort()).toEqual(['manual', 'partner']);
  });
});
