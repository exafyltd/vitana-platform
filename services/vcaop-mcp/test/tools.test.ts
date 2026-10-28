/** Per-tool behavior over the synthetic backend. */
import { makeHarness, mintToken, rpc, toolsCallBody, toolErrorOf } from './helpers';

const token = () => mintToken();

describe('read tools', () => {
  test('get_product returns the product; unknown id → stable not_found', async () => {
    const { app } = makeHarness();
    const ok = await rpc(app, token(), toolsCallBody('get_product', { product_id: 'tenant-a-prod-1' }));
    expect(ok.body.result.structuredContent.product.title).toContain('Omega-3');

    const missing = await rpc(app, token(), toolsCallBody('get_product', { product_id: 'nope' }));
    const err = toolErrorOf(missing.body);
    expect(err?.code).toBe('not_found');
    expect(err?.message).toContain('search_products'); // actionable guidance
  });

  test('compare_offers lists offers across merchants with rewards flags', async () => {
    const { app } = makeHarness();
    const res = await rpc(app, token(), toolsCallBody('compare_offers', { product_id: 'tenant-a-prod-1' }));
    const sc = res.body.result.structuredContent;
    expect(sc.count).toBe(2);
    expect(sc.offers.map((o: any) => o.rewards_enabled)).toEqual([true, false]);
  });

  test('get_inventory returns stock status', async () => {
    const { app } = makeHarness();
    const res = await rpc(app, token(), toolsCallBody('get_inventory', { product_id: 'tenant-a-prod-2' }));
    expect(res.body.result.structuredContent.inventory.status).toBe('low_stock');
  });

  test('get_cart returns the OWN user cart with no user parameter accepted', async () => {
    const { app } = makeHarness();
    const res = await rpc(app, token(), toolsCallBody('get_cart', {}));
    expect(res.body.result.structuredContent.cart.id).toBe('tenant-a-cart-1');
  });

  test('get_order + get_order_status for an own order; foreign order id → not_found', async () => {
    const { app } = makeHarness();
    const ok = await rpc(app, token(), toolsCallBody('get_order', { order_id: 'tenant-a-order-1' }));
    expect(ok.body.result.structuredContent.order.status).toBe('confirmed');

    const status = await rpc(app, token(), toolsCallBody('get_order_status', { order_id: 'tenant-a-order-1' }));
    expect(status.body.result.structuredContent).toEqual({ id: 'tenant-a-order-1', status: 'confirmed' });

    // Another tenant's order id must be indistinguishable from a nonexistent one.
    const foreign = await rpc(app, token(), toolsCallBody('get_order', { order_id: 'tenant-b-order-1' }));
    expect(toolErrorOf(foreign.body)?.code).toBe('not_found');
  });

  test('get_wallet and get_rewards return the own ledger projection', async () => {
    const { app } = makeHarness();
    const wallet = await rpc(app, token(), toolsCallBody('get_wallet', {}));
    expect(wallet.body.result.structuredContent.wallet.redeemable).toBe('4.50');

    const rewards = await rpc(app, token(), toolsCallBody('get_rewards', { limit: 10 }));
    expect(rewards.body.result.structuredContent.rewards[0].state).toBe('pending');
  });

  test('get_partner_capabilities lists partners without connector internals', async () => {
    const { app } = makeHarness();
    const res = await rpc(app, token(), toolsCallBody('get_partner_capabilities', {}));
    const sc = res.body.result.structuredContent;
    expect(sc.partners[0].provider).toBe('admitad');
    // Never expose credential material or refs through this surface.
    expect(JSON.stringify(sc)).not.toMatch(/(secret|credential|_ref)/i);
  });
});
