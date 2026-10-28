/** Tenant isolation and audit discipline. */
import { makeHarness, mintToken, rpc, toolsCallBody } from './helpers';
import { assertAuditSafe, AuditEvent } from '../src/audit/audit-sink';

describe('tenant isolation', () => {
  test('identical query in tenant-b returns ONLY tenant-b data', async () => {
    const { app } = makeHarness();
    const tokenB = mintToken({ sub: 'tenant-b-user-1', tenant_id: 'tenant-b' });
    const res = await rpc(app, tokenB, toolsCallBody('search_products', { query: 'omega' }));
    const ids = res.body.result.structuredContent.products.map((p: any) => p.id);
    expect(ids).toEqual(['tenant-b-prod-1']);
    expect(JSON.stringify(res.body)).not.toContain('tenant-a-');
  });

  test('unknown tenant sees empty data, never another tenant’s', async () => {
    const { app } = makeHarness();
    const tokenX = mintToken({ tenant_id: 'tenant-x' });
    const res = await rpc(app, tokenX, toolsCallBody('search_products', { query: 'omega' }));
    expect(res.body.result.structuredContent.total).toBe(0);
  });

  test('wallet is user-scoped: another user in the same tenant gets a zero wallet, not user-1’s', async () => {
    const { app } = makeHarness();
    const tokenOther = mintToken({ sub: 'tenant-a-user-2' });
    const res = await rpc(app, tokenOther, toolsCallBody('get_wallet', {}));
    expect(res.body.result.structuredContent.wallet.redeemable).toBe('0.00');
  });
});

describe('audit', () => {
  test('every tool call emits exactly one sanitized audit event with outcome + duration', async () => {
    const { app, audit } = makeHarness();
    await rpc(app, mintToken(), toolsCallBody('get_wallet', {}));
    await rpc(app, mintToken(), toolsCallBody('get_product', { product_id: 'nope' }));

    expect(audit.events).toHaveLength(2);
    const [ok, notFound] = audit.events;
    expect(ok.topic).toBe('mcp.tool.get_wallet');
    expect(ok.status).toBe('success');
    expect(notFound.topic).toBe('mcp.tool.get_product');
    expect(notFound.status).toBe('error');
    expect(notFound.payload.outcome).toBe('not_found');
    for (const e of audit.events) {
      expect(typeof e.payload.duration_ms).toBe('number');
      expect(() => assertAuditSafe(e)).not.toThrow();
      // Audit must not carry tool inputs/outputs.
      expect(JSON.stringify(e)).not.toContain('nope');
      expect(JSON.stringify(e)).not.toContain('4.50');
    }
  });

  test('assertAuditSafe rejects forbidden keys and email-shaped PII', () => {
    const bad = {
      service: 'vcaop-mcp',
      topic: 't',
      status: 'success',
      message: 'm',
      payload: {
        tool: 't', tenant_id: 'a', user_id: 'contact: someone@example.com',
        client_id: 'c', outcome: 'ok', duration_ms: 1,
      },
      createdAt: new Date().toISOString(),
    } as unknown as AuditEvent;
    expect(() => assertAuditSafe(bad)).toThrow(/PII/);

    const badKey = { ...bad, payload: { ...bad.payload, user_id: 'u', credential_ref: 'x' } };
    expect(() => assertAuditSafe(badKey as unknown as AuditEvent)).toThrow(/forbidden key/);
  });
});
