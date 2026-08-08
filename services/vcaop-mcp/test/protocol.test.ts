/** MCP protocol behavior: initialize, scope-filtered discovery, valid calls. */
import { makeHarness, mintToken, rpc, initializeBody, toolsListBody, toolsCallBody } from './helpers';
import { SCOPES } from '../src/auth/scopes';
import { READ_TOOLS } from '../src/tools/registry';

describe('MCP protocol', () => {
  test('initialize succeeds and reports server identity', async () => {
    const { app } = makeHarness();
    const res = await rpc(app, mintToken(), initializeBody());
    expect(res.status).toBe(200);
    expect(res.body.result.serverInfo.name).toBe('vitanaland-mcp-server');
    expect(res.body.result.protocolVersion).toBeDefined();
  });

  test('tools/list with full scopes exposes all 10 read tools, all read-only annotated', async () => {
    const { app } = makeHarness();
    const res = await rpc(app, mintToken(), toolsListBody());
    expect(res.status).toBe(200);
    const tools = res.body.result.tools as Array<any>;
    expect(tools.map((t) => t.name).sort()).toEqual(
      READ_TOOLS.map((t) => t.decl.name).sort(),
    );
    for (const t of tools) {
      expect(t.annotations.readOnlyHint).toBe(true);
      expect(t.annotations.destructiveHint).toBe(false);
      expect(t.inputSchema).toBeDefined();
    }
  });

  test('tools/list discovery is scope-filtered: wallet-only token sees only get_wallet', async () => {
    const { app } = makeHarness();
    const token = mintToken({ scope: SCOPES.WALLET_READ });
    const res = await rpc(app, token, toolsListBody());
    const names = (res.body.result.tools as Array<any>).map((t) => t.name);
    expect(names).toEqual(['get_wallet']);
  });

  test('valid tools/call returns structured content', async () => {
    const { app } = makeHarness();
    const res = await rpc(app, mintToken(), toolsCallBody('search_products', { query: 'omega' }));
    expect(res.status).toBe(200);
    const sc = res.body.result.structuredContent;
    expect(sc.total).toBe(1);
    expect(sc.products[0].id).toBe('tenant-a-prod-1');
    expect(res.body.result.isError).toBeFalsy();
  });

  test('every registered tool declares scopes, audit type and read-only contract', () => {
    for (const t of READ_TOOLS) {
      expect(t.decl.requiredScopes.length).toBeGreaterThan(0);
      expect(t.decl.auditEventType).toBe(`mcp.tool.${t.decl.name}`);
      expect(t.decl.readOnly).toBe(true);
      expect(t.decl.destructive).toBe(false);
      expect(t.decl.idempotency).toBe('none');
      expect(t.decl.policyChecks).toContain('scope');
      expect(t.decl.policyChecks).toContain('tenant_context');
    }
  });

  test('GET /mcp is refused in stateless mode', async () => {
    const { app } = makeHarness();
    const res = await (await import('supertest')).default(app)
      .get('/mcp')
      .set('Authorization', `Bearer ${mintToken()}`);
    expect(res.status).toBe(405);
  });
});
