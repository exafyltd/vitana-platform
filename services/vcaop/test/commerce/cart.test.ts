import { CartService, FTC_DISCLOSURE_TEXT } from '../../src/commerce/cart';
import { pickCheckout, CHECKOUT_LADDER } from '../../src/commerce/checkout';
import { InMemoryRepository } from '../../src/api/repository';
import { InMemoryOasisSink } from '../../src/api/oasis-sink';
import { mintSubId } from '../../src/agents/monetization';

function setup() {
  const repo = new InMemoryRepository();
  const oasis = new InMemoryOasisSink();
  return { repo, oasis, cart: new CartService(repo, oasis) };
}

describe('CMRC-CART-0001 — Universal Cart + checkout ladder', () => {
  test('pickCheckout prefers API-class over browser', () => {
    expect(pickCheckout(['skyvern', 'violet'])).toBe('violet'); // violet (API) beats skyvern (browser)
    expect(pickCheckout(['rye'])).toBe('rye');
    expect(pickCheckout([])).toBe('skyvern'); // fallback
    expect(CHECKOUT_LADDER[0]).toBe('ucp');
  });

  test('builds and routes a multi-merchant cart with per-merchant SubID', async () => {
    const { cart, repo } = setup();
    const built = await cart.buildAndRoute('u1', [
      { merchant: 'shopx', items: [{ sku: 'a', qty: 2, price: 10 }], supports: ['shopify_agent'], affiliateProgramId: 'progA' },
      { merchant: 'shopy', items: [{ sku: 'b', qty: 1, price: 25 }], supports: ['rye'], affiliateProgramId: 'progB' },
    ]);
    expect(built.routes).toHaveLength(2);
    expect(built.total).toBe(45);
    expect(built.routes[0].checkoutConnector).toBe('shopify_agent');
    expect(built.routes[1].checkoutConnector).toBe('rye');
    expect(built.routes[0].subId).toBe(mintSubId('u1', 'progA'));
    // persisted merchant routes
    const routes = await repo.list('merchant_route', (r) => r.cart_order_id === built.cartOrderId);
    expect(routes).toHaveLength(2);
    expect(routes.every((r) => r.status === 'routed')).toBe(true);
  });

  test('every cart carries a NON-DISMISSIBLE FTC disclosure', async () => {
    const { cart, repo } = setup();
    const built = await cart.buildAndRoute('u1', [{ merchant: 'shopx', items: [{ sku: 'a', qty: 1, price: 5 }] }]);
    const disclosure = await repo.get('disclosure', built.disclosureId);
    expect(disclosure!.dismissible).toBe(false);
    expect(disclosure!.kind).toBe('ftc_affiliate');
    expect(disclosure!.text).toBe(FTC_DISCLOSURE_TEXT);
  });

  test('cart total and status reflect routing', async () => {
    const { cart, repo } = setup();
    const built = await cart.buildAndRoute('u1', [{ merchant: 'm', items: [{ sku: 'x', qty: 3, price: 7 }] }]);
    const order = await repo.get('cart_order', built.cartOrderId);
    expect(order!.status).toBe('routed');
    expect(order!.total_amount).toBe(21);
  });
});
