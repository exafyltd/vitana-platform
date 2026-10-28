/** Phase 6 — write tools: scopes, confirmation gate, idempotency, e2e commerce flow. */
import express from 'express';
import { buildApp } from '../src/app';
import { HmacTokenVerifier, InMemoryRevocationStore } from '../src/auth/token-verifier';
import { MemoryReadBackend } from '../src/backend/memory-backend';
import { MemoryWriteBackend } from '../src/backend/memory-write-backend';
import { InMemoryAuditSink } from '../src/audit/audit-sink';
import { SCOPES } from '../src/auth/scopes';
import { mintToken, rpc, toolsCallBody, toolsListBody, toolErrorOf, TEST_SECRET, RESOURCE_URL } from './helpers';

function makeWriteHarness() {
  const audit = new InMemoryAuditSink();
  const writeBackend = new MemoryWriteBackend();
  const app = buildApp({
    backend: new MemoryReadBackend(),
    writeBackend,
    audit,
    verifier: new HmacTokenVerifier({
      secret: TEST_SECRET,
      audience: RESOURCE_URL,
      revocations: new InMemoryRevocationStore(),
    }),
    resourceUrl: RESOURCE_URL,
    authorizationServers: ['http://localhost:9000'],
  });
  return { app, audit, writeBackend };
}

const WRITE_SCOPES = [
  SCOPES.CART_WRITE,
  SCOPES.ORDERS_WRITE,
  SCOPES.CONNECTIONS_WRITE,
  SCOPES.GRANTS_WRITE,
  SCOPES.SETTLEMENT_WRITE,
].join(' ');

const writeToken = (scope = WRITE_SCOPES) => mintToken({ scope });

const call = (app: express.Express, token: string, name: string, args: Record<string, unknown>) =>
  rpc(app, token, toolsCallBody(name, args));

describe('write tool surface', () => {
  test('without a write backend, no write tool exists at all (Phase 1 config unchanged)', async () => {
    // The default read-only harness from helpers has no writeBackend. With
    // write-only scopes NOTHING registers, so tools/list is either an empty
    // list or the SDK's no-tools-capability error — never a write tool.
    const { makeHarness } = await import('./helpers');
    const { app } = makeHarness();
    const res = await rpc(app, mintToken({ scope: WRITE_SCOPES }), toolsListBody());
    const tools = res.body.result?.tools ?? [];
    expect(tools).toEqual([]);
  });

  test('discovery is scope-filtered per write family', async () => {
    const { app } = makeWriteHarness();
    const res = await rpc(app, writeToken(SCOPES.CART_WRITE), toolsListBody());
    const names = (res.body.result.tools as Array<{ name: string }>).map((t) => t.name).sort();
    expect(names).toEqual(['add_cart_item', 'create_cart', 'create_checkout_session']);
  });

  test('e2e: cart → item → checkout session → confirmed order, with confirmation on confirm only', async () => {
    const { app } = makeWriteHarness();
    const token = writeToken();

    const cart = await call(app, token, 'create_cart', { idempotency_key: 'e2e-cart-1' });
    const cartId = cart.body.result.structuredContent.id;
    expect(cartId).toMatch(/^cart-/);

    await call(app, token, 'add_cart_item', {
      cart_id: cartId,
      product_id: 'tenant-a-prod-1',
      quantity: 1,
      idempotency_key: 'e2e-item-1',
    });

    const session = await call(app, token, 'create_checkout_session', {
      cart_id: cartId,
      idempotency_key: 'e2e-cks-1',
    });
    const sessionId = session.body.result.structuredContent.id;
    expect(session.body.result.structuredContent.status).toBe('pending_confirmation');

    // Without explicit user confirmation the order is REFUSED…
    const refused = await call(app, token, 'confirm_order', {
      checkout_session_id: sessionId,
      idempotency_key: 'e2e-ord-1',
    });
    expect(toolErrorOf(refused.body)?.code).toBe('confirmation_required');

    // …and succeeds only with it.
    const confirmed = await call(app, token, 'confirm_order', {
      checkout_session_id: sessionId,
      user_confirmation: true,
      idempotency_key: 'e2e-ord-1',
    });
    expect(confirmed.body.result.structuredContent.status).toBe('confirmed');
  });

  test('DoD item 12 at the tool surface: duplicate idempotency keys return the ORIGINAL result, no double effect', async () => {
    const { app, writeBackend } = makeWriteHarness();
    const token = writeToken();
    const a = await call(app, token, 'create_cart', { idempotency_key: 'dup-cart-1' });
    const b = await call(app, token, 'create_cart', { idempotency_key: 'dup-cart-1' });
    expect(b.body.result.structuredContent.id).toBe(a.body.result.structuredContent.id);
    expect(writeBackend.carts.size).toBe(1);
  });

  test('cancel_order and approve_data_grant are confirmation-gated; revoke_data_grant deliberately is not', async () => {
    const { app } = makeWriteHarness();
    const token = writeToken();
    const refused = await call(app, token, 'cancel_order', { order_id: 'x', idempotency_key: 'cnl-00001' });
    expect(toolErrorOf(refused.body)?.code).toBe('confirmation_required');

    const grant = await call(app, token, 'request_data_grant', {
      grantee: 'Sandbox Insurer AG',
      purpose: 'underwriting evidence for tariff quote',
      idempotency_key: 'grant-001',
    });
    const grantId = grant.body.result.structuredContent.id;

    const approveRefused = await call(app, token, 'approve_data_grant', { grant_id: grantId, idempotency_key: 'appr-00001' });
    expect(toolErrorOf(approveRefused.body)?.code).toBe('confirmation_required');

    // Revocation is friction-free — user-protective actions never need a confirmation dance.
    await call(app, token, 'approve_data_grant', { grant_id: grantId, user_confirmation: true, idempotency_key: 'appr-0001b' });
    const revoked = await call(app, token, 'revoke_data_grant', { grant_id: grantId, idempotency_key: 'rvk-00001' });
    expect(revoked.body.result.structuredContent.status).toBe('revoked');
  });

  test('settle_vtna has no amount parameter and rejects non-settleable instruction types', async () => {
    const { app } = makeWriteHarness();
    const token = writeToken();
    const ok = await call(app, token, 'settle_vtna', {
      instruction_type: 'affiliate_reward',
      reference: 'commission-evt-123',
      user_confirmation: true,
      idempotency_key: 'stl-00001',
    });
    const sc = ok.body.result.structuredContent;
    expect(sc.status).toBe('accepted');
    expect(sc.computed_amount).toBe('100'); // computed server-side, never client-supplied

    // The schema itself has no amount field — an attacker-supplied amount is
    // simply not part of the contract; and a disallowed type is refused.
    const bad = await call(app, token, 'settle_vtna', {
      instruction_type: 'dispute_adjustment',
      reference: 'x-1',
      user_confirmation: true,
      idempotency_key: 'stl-00002',
    });
    const hasError = bad.body.result?.isError || !!bad.body.error;
    expect(hasError).toBe(true);
  });

  test('missing write scope: tool invisible and uncallable', async () => {
    const { app } = makeWriteHarness();
    const readOnly = mintToken({ scope: SCOPES.CATALOG_READ });
    const res = await call(app, readOnly, 'confirm_order', {
      checkout_session_id: 'x',
      user_confirmation: true,
      idempotency_key: 'nope-123',
    });
    expect(res.body.result.isError).toBe(true);
    expect(res.body.result.content[0].text).toContain('not found');
  });

  test('denied confirmations are audited without leaking inputs', async () => {
    const { app, audit } = makeWriteHarness();
    await call(app, writeToken(), 'confirm_order', { checkout_session_id: 'cks-secret-99', idempotency_key: 'aud-00001' });
    const denial = audit.events.find((e) => e.payload.outcome === 'confirmation_required');
    expect(denial).toBeDefined();
    expect(JSON.stringify(denial)).not.toContain('cks-secret-99');
  });
});
