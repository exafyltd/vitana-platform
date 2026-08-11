/** OAuth resource-server behavior: token failures, scopes, revocation, metadata. */
import request from 'supertest';
import { makeHarness, mintToken, rpc, toolsCallBody, RESOURCE_URL } from './helpers';
import { SCOPES, ALL_SCOPES } from '../src/auth/scopes';
import { mintHs256Token } from '../src/auth/token-verifier';

describe('authorization', () => {
  test('missing token → 401 with WWW-Authenticate pointing at resource metadata', async () => {
    const { app } = makeHarness();
    const res = await rpc(app, null, toolsCallBody('get_wallet'));
    expect(res.status).toBe(401);
    expect(res.headers['www-authenticate']).toContain('resource_metadata=');
    expect(res.body.error.code).toBe('unauthorized');
  });

  test('expired token → 401 (expired)', async () => {
    const { app } = makeHarness();
    const token = mintToken({ exp: Math.floor(Date.now() / 1000) - 60 });
    const res = await rpc(app, token, toolsCallBody('get_wallet'));
    expect(res.status).toBe(401);
    expect(res.headers['www-authenticate']).toContain('expired');
  });

  test('wrong audience → 401 (audience validation)', async () => {
    const { app } = makeHarness();
    const token = mintToken({ aud: 'https://some-other-resource.example/mcp' });
    const res = await rpc(app, token, toolsCallBody('get_wallet'));
    expect(res.status).toBe(401);
    expect(res.headers['www-authenticate']).toContain('wrong_audience');
  });

  test('tampered signature → 401', async () => {
    const { app } = makeHarness();
    const token = mintHs256Token('wrong-secret', {
      sub: 'x', tenant_id: 'tenant-a', client_id: 'c', scope: ALL_SCOPES.join(' '),
      aud: RESOURCE_URL, exp: Math.floor(Date.now() / 1000) + 3600,
    });
    const res = await rpc(app, token, toolsCallBody('get_wallet'));
    expect(res.status).toBe(401);
    expect(res.headers['www-authenticate']).toContain('bad_signature');
  });

  test('revoked token → 401 immediately (DoD: revocation prevents further access)', async () => {
    const { app, revocations } = makeHarness();
    const token = mintToken({ jti: 'jti-to-revoke' });
    // Works before revocation…
    const ok = await rpc(app, token, toolsCallBody('get_wallet'));
    expect(ok.status).toBe(200);
    // …and is rejected on the very next request after revocation.
    revocations.revoke('jti-to-revoke');
    const denied = await rpc(app, token, toolsCallBody('get_wallet'));
    expect(denied.status).toBe(401);
    expect(denied.headers['www-authenticate']).toContain('revoked');
  });

  test('missing scope: tool is not registered, so calling it reads as nonexistent', async () => {
    const { app } = makeHarness();
    const token = mintToken({ scope: SCOPES.WALLET_READ });
    // get_order requires orders:read which this token lacks. The tool is not
    // even registered for this request, and the SDK answers "Tool not found" —
    // deliberately indistinguishable from a tool that does not exist, so an
    // under-scoped client learns nothing about the full tool surface.
    const res = await rpc(app, token, toolsCallBody('get_order', { order_id: 'x' }));
    expect(res.status).toBe(200); // JSON-RPC layer answers; the error is in-band
    expect(res.body.result.isError).toBe(true);
    expect(res.body.result.content[0].text).toContain('not found');
    expect(res.body.result.structuredContent).toBeUndefined();
  });

  test('token without tenant claim → 401 (missing_claims)', async () => {
    const { app } = makeHarness();
    const token = mintToken({ tenant_id: undefined });
    const res = await rpc(app, token, toolsCallBody('get_wallet'));
    expect(res.status).toBe(401);
    expect(res.headers['www-authenticate']).toContain('missing_claims');
  });

  test('protected-resource metadata is served unauthenticated (RFC 9728)', async () => {
    const { app } = makeHarness();
    const res = await request(app).get('/.well-known/oauth-protected-resource');
    expect(res.status).toBe(200);
    expect(res.body.resource).toBe(RESOURCE_URL);
    expect(res.body.authorization_servers).toEqual(['http://localhost:9000']);
    expect(res.body.scopes_supported).toEqual(ALL_SCOPES);
  });

  test('invalid input → stable invalid_input-class error from the SDK validation layer', async () => {
    const { app } = makeHarness();
    const res = await rpc(app, mintToken(), toolsCallBody('search_products', { query: '' }));
    // Zod rejects the empty query; the failure must be an in-band error, never data.
    const hasRpcError = !!res.body.error;
    const hasToolError = !!res.body.result?.isError;
    expect(hasRpcError || hasToolError).toBe(true);
  });
});
