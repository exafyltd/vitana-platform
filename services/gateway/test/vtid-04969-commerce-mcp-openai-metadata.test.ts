/**
 * VTID-04969 — what OpenAI's plugin review reads from the Commerce MCP: every
 * tool declares readOnly / destructive / openWorld as explicit booleans and the
 * OAuth scheme it needs, and the domain-verification token is served as plain
 * text. The tool-level sign-in challenge waits on the live OpenAI spec (Phase 0).
 */
import express from 'express';
import request from 'supertest';

jest.mock('../src/middleware/auth-supabase-jwt', () => ({
  verifyAndExtractIdentity: jest.fn(),
  requireAuth: (_req: any, _res: any, next: any) => next(),
  optionalAuth: (_req: any, _res: any, next: any) => next(),
}));
jest.mock('../src/lib/supabase', () => ({ getSupabase: () => ({}) }));
jest.mock('../src/services/oasis-event-service', () => ({ emitOasisEvent: jest.fn().mockResolvedValue({ ok: true }) }));
jest.mock('../src/services/mcp-client-allowlist', () => ({ checkMcpClient: jest.fn() }));

import { COMMERCE_MCP_TOOLS, MCP_SCOPES, handleJsonRpc } from '../src/services/commerce-mcp';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const routes = require('../src/routes/commerce-mcp');

const prev = { ...process.env };
afterEach(() => {
  process.env = { ...prev };
});

describe('tool metadata for the OpenAI review', () => {
  const tools = COMMERCE_MCP_TOOLS as unknown as Array<Record<string, any>>;

  it('every tool sets all three hints as explicit booleans', () => {
    for (const t of tools) {
      for (const k of ['readOnlyHint', 'destructiveHint', 'openWorldHint']) {
        expect(typeof t.annotations[k]).toBe('boolean');
      }
    }
  });
  it('reads are read-only, nothing is destructive, and only tools that reach outside are open-world', () => {
    expect(tools.filter((t) => t.annotations.readOnlyHint).map((t) => t.name)).toEqual(['get_onboarding_status', 'list_products']);
    expect(tools.filter((t) => t.annotations.destructiveHint).map((t) => t.name)).toEqual([]);
    expect(tools.filter((t) => t.annotations.openWorldHint).map((t) => t.name).sort()).toEqual(['check_verification', 'connect_store']);
  });
  it('every tool needs the OAuth sign-in, mirrored in _meta, without openid', () => {
    for (const t of tools) {
      expect(t.securitySchemes).toEqual([{ type: 'oauth2', scopes: [...MCP_SCOPES] }]);
      expect(t._meta.securitySchemes).toEqual(t.securitySchemes);
    }
    expect(MCP_SCOPES).not.toContain('openid');
    expect(routes.MCP_SCOPES).toEqual(MCP_SCOPES);
  });
  it('names are unique plain-language actions with titles and descriptions', () => {
    const names = tools.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const t of tools) {
      expect(t.name).toMatch(/^[a-z]+(_[a-z]+)+$/);
      expect(t.title.length).toBeGreaterThan(2);
      expect(t.description.length).toBeGreaterThan(20);
      expect(t.inputSchema.type).toBe('object');
    }
  });
  it('tools/list serves the same descriptors', async () => {
    const r: any = await handleJsonRpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, {} as any);
    expect(r.result.tools).toEqual(COMMERCE_MCP_TOOLS);
  });
});

describe('domain verification challenge', () => {
  const app = () => {
    const a = express();
    a.use('/.well-known', routes.wellKnownRouter);
    return a;
  };
  it('serves exactly the token as plain text', async () => {
    process.env.OPENAI_APPS_CHALLENGE_TOKEN = '  abc123-token \n';
    const res = await request(app()).get('/.well-known/openai-apps-challenge');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/plain/);
    expect(res.text).toBe('abc123-token');
  });
  it('is 404 until a token is configured, and does not depend on the MCP switch', async () => {
    delete process.env.OPENAI_APPS_CHALLENGE_TOKEN;
    expect((await request(app()).get('/.well-known/openai-apps-challenge')).status).toBe(404);
    process.env.COMMERCE_MCP_ENABLED = 'false';
    process.env.OPENAI_APPS_CHALLENGE_TOKEN = 'tok';
    expect((await request(app()).get('/.well-known/openai-apps-challenge')).text).toBe('tok');
  });
});
