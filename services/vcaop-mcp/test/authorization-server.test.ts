/**
 * BLK-007 — embedded OAuth 2.1 authorization server (VTID-03545).
 * Full DCR → authorize (consent handoff) → PKCE token exchange → ES256
 * verification → MCP call, plus the replay/rotation defenses OAuth 2.1
 * demands. Synthetic identities only.
 */
import * as crypto from 'crypto';
import express from 'express';
import request from 'supertest';
import { AuthorizationServer, IdentityVerifier, OAuthError, SupabaseIdentityVerifier } from '../src/auth/authorization-server';
import { buildAuthServerRouter } from '../src/auth/auth-server-router';
import { SigningKeys } from '../src/auth/keys';
import { Es256TokenVerifier } from '../src/auth/token-verifier';
import { buildApp } from '../src/app';
import { MemoryReadBackend } from '../src/backend/memory-backend';
import { InMemoryAuditSink } from '../src/audit/audit-sink';

const RESOURCE = 'https://mcp.vitanaland.com/mcp';
const ISSUER = 'https://mcp.vitanaland.com';
const CONSENT = 'https://vitanaland.com/oauth/consent';

let clock = Date.parse('2026-08-09T12:00:00Z');
const now = () => clock;

const okIdentity: IdentityVerifier = {
  verify: async (token) =>
    token === 'valid-supabase-token' ? { userId: 'user-1', tenantId: 'tenant-a' } : null,
};

function makeAs() {
  const keys = SigningKeys.ephemeral();
  const as = new AuthorizationServer({
    issuer: ISSUER,
    resourceUrl: RESOURCE,
    consentUrl: CONSENT,
    keys,
    identity: okIdentity,
    now,
  });
  return { as, keys };
}

function pkce() {
  const verifier = crypto.randomBytes(48).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

async function fullFlow(as: AuthorizationServer) {
  const client = as.registerClient({
    client_name: 'Claude Connector',
    redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
  });
  const { verifier, challenge } = pkce();
  const params = {
    client_id: client.client_id,
    redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
    response_type: 'code',
    scope: 'vitana:catalog:read vitana:cart:write',
    state: 'xyz',
    code_challenge: challenge,
    code_challenge_method: 'S256',
  };
  const { redirectTo } = await as.decision({
    params,
    supabaseAccessToken: 'valid-supabase-token',
    approved: true,
  });
  const code = new URL(redirectTo).searchParams.get('code')!;
  return { client, verifier, challenge, params, code };
}

beforeEach(() => {
  clock = Date.parse('2026-08-09T12:00:00Z');
});

describe('metadata + registration', () => {
  test('RFC 8414 metadata advertises exactly what MCP connectors need', () => {
    const { as } = makeAs();
    const md = as.metadata();
    expect(md.issuer).toBe(ISSUER);
    expect(md.code_challenge_methods_supported).toEqual(['S256']);
    expect(md.grant_types_supported).toEqual(['authorization_code', 'refresh_token']);
    expect(md.token_endpoint_auth_methods_supported).toEqual(['none']);
    expect(md.registration_endpoint).toBe(`${ISSUER}/oauth/register`);
  });

  test('DCR: https and loopback redirect URIs accepted, anything else refused', () => {
    const { as } = makeAs();
    const ok = as.registerClient({
      client_name: 'Dev CLI',
      redirect_uris: ['http://127.0.0.1:3311/callback', 'https://claude.ai/cb'],
    });
    expect(ok.client_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(ok.token_endpoint_auth_method).toBe('none');
    expect(() =>
      as.registerClient({ client_name: 'Evil', redirect_uris: ['http://evil.example/cb'] }),
    ).toThrow(OAuthError);
    expect(() => as.registerClient({ client_name: 'NoUris', redirect_uris: [] })).toThrow(/redirect_uris/);
  });

  test('unknown scopes are dropped at registration; all-unknown is refused', () => {
    const { as } = makeAs();
    const c = as.registerClient({
      client_name: 'Scoped',
      redirect_uris: ['https://x.example/cb'],
      scope: 'vitana:catalog:read admin:everything',
    });
    expect(c.scope).toBe('vitana:catalog:read');
    expect(() =>
      as.registerClient({ client_name: 'Bad', redirect_uris: ['https://x.example/cb'], scope: 'root:all' }),
    ).toThrow(/scope/);
  });
});

describe('authorize + consent handoff', () => {
  test('authorize validates client/redirect/PKCE then redirects to the consent page', () => {
    const { as } = makeAs();
    const client = as.registerClient({ client_name: 'C', redirect_uris: ['https://claude.ai/cb'] });
    const { challenge } = pkce();
    const target = as.buildConsentRedirect({
      client_id: client.client_id,
      redirect_uri: 'https://claude.ai/cb',
      response_type: 'code',
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    const u = new URL(target);
    expect(`${u.origin}${u.pathname}`).toBe(CONSENT);
    expect(u.searchParams.get('client_name')).toBe('C');
  });

  test('plain PKCE, unregistered redirect_uri, and missing challenge are all refused', () => {
    const { as } = makeAs();
    const client = as.registerClient({ client_name: 'C', redirect_uris: ['https://claude.ai/cb'] });
    const { challenge } = pkce();
    const base = {
      client_id: client.client_id,
      redirect_uri: 'https://claude.ai/cb',
      response_type: 'code',
      code_challenge: challenge,
      code_challenge_method: 'S256',
    };
    expect(() => as.buildConsentRedirect({ ...base, code_challenge_method: 'plain' })).toThrow(/S256/);
    expect(() => as.buildConsentRedirect({ ...base, redirect_uri: 'https://claude.ai/other' })).toThrow(/registered/);
    expect(() => as.buildConsentRedirect({ ...base, code_challenge: undefined })).toThrow(/code_challenge/);
  });

  test('denied consent redirects back with error=access_denied and no code', async () => {
    const { as } = makeAs();
    const client = as.registerClient({ client_name: 'C', redirect_uris: ['https://claude.ai/cb'] });
    const { challenge } = pkce();
    const { redirectTo } = await as.decision({
      params: {
        client_id: client.client_id,
        redirect_uri: 'https://claude.ai/cb',
        response_type: 'code',
        state: 's1',
        code_challenge: challenge,
        code_challenge_method: 'S256',
      },
      supabaseAccessToken: '',
      approved: false,
    });
    const u = new URL(redirectTo);
    expect(u.searchParams.get('error')).toBe('access_denied');
    expect(u.searchParams.get('state')).toBe('s1');
    expect(u.searchParams.get('code')).toBeNull();
  });

  test('a bad Supabase token cannot mint a code', async () => {
    const { as } = makeAs();
    const client = as.registerClient({ client_name: 'C', redirect_uris: ['https://claude.ai/cb'] });
    const { challenge } = pkce();
    await expect(
      as.decision({
        params: {
          client_id: client.client_id,
          redirect_uri: 'https://claude.ai/cb',
          response_type: 'code',
          code_challenge: challenge,
          code_challenge_method: 'S256',
        },
        supabaseAccessToken: 'forged',
        approved: true,
      }),
    ).rejects.toThrow(/authentication failed/);
  });

  test('granted scopes = requested ∩ registered ∩ approved', async () => {
    const { as } = makeAs();
    const client = as.registerClient({
      client_name: 'C',
      redirect_uris: ['https://claude.ai/cb'],
      scope: 'vitana:catalog:read vitana:cart:write',
    });
    const { verifier, challenge } = pkce();
    const { redirectTo } = await as.decision({
      params: {
        client_id: client.client_id,
        redirect_uri: 'https://claude.ai/cb',
        response_type: 'code',
        scope: 'vitana:catalog:read vitana:cart:write vitana:wallet:read',
        code_challenge: challenge,
        code_challenge_method: 'S256',
      },
      supabaseAccessToken: 'valid-supabase-token',
      approved: true,
      approvedScopes: ['vitana:catalog:read'], // the human ticked ONE box
    });
    const code = new URL(redirectTo).searchParams.get('code')!;
    const tokens = as.token({
      grant_type: 'authorization_code',
      code,
      client_id: client.client_id,
      redirect_uri: 'https://claude.ai/cb',
      code_verifier: verifier,
    });
    expect(tokens.scope).toBe('vitana:catalog:read');
  });
});

describe('token endpoint — PKCE + replay defenses', () => {
  test('happy path mints an ES256 token the resource verifier accepts', async () => {
    const { as, keys } = makeAs();
    const { client, verifier, code } = await fullFlow(as);
    const tokens = as.token({
      grant_type: 'authorization_code',
      code,
      client_id: client.client_id,
      redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
      code_verifier: verifier,
    });
    expect(tokens.token_type).toBe('Bearer');
    const rsVerifier = new Es256TokenVerifier({
      publicKey: keys.publicKey,
      issuer: ISSUER,
      audience: RESOURCE,
      now,
    });
    const result = await rsVerifier.verify(tokens.access_token);
    expect(result.ok).toBe(true);
    expect(result.context).toMatchObject({
      userId: 'user-1',
      tenantId: 'tenant-a',
      clientId: client.client_id,
      scopes: ['vitana:catalog:read', 'vitana:cart:write'],
    });
  });

  test('a wrong PKCE verifier is refused', async () => {
    const { as } = makeAs();
    const { client, code } = await fullFlow(as);
    expect(() =>
      as.token({
        grant_type: 'authorization_code',
        code,
        client_id: client.client_id,
        redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
        code_verifier: crypto.randomBytes(48).toString('base64url'),
      }),
    ).toThrow(/PKCE/);
  });

  test('code reuse revokes the tokens the code minted', async () => {
    const { as, keys } = makeAs();
    const { client, verifier, code } = await fullFlow(as);
    const exchange = () =>
      as.token({
        grant_type: 'authorization_code',
        code,
        client_id: client.client_id,
        redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
        code_verifier: verifier,
      });
    const tokens = exchange();
    expect(() => exchange()).toThrow(/already used/);
    // The first exchange's access token is now revoked.
    const rsVerifier = new Es256TokenVerifier({
      publicKey: keys.publicKey,
      issuer: ISSUER,
      audience: RESOURCE,
      revocations: { isRevoked: async (jti) => as.isJtiRevoked(jti) },
      now,
    });
    const result = await rsVerifier.verify(tokens.access_token);
    expect(result).toMatchObject({ ok: false, reason: 'revoked' });
  });

  test('code reuse ALSO burns the refresh family the exchange minted (Codex P1)', async () => {
    const { as } = makeAs();
    const { client, verifier, code } = await fullFlow(as);
    const exchange = () =>
      as.token({
        grant_type: 'authorization_code',
        code,
        client_id: client.client_id,
        redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
        code_verifier: verifier,
      });
    const tokens = exchange();
    expect(() => exchange()).toThrow(/already used/);
    // The surviving refresh token from the original exchange must NOT be able
    // to mint a fresh, unrevoked access token around the replay defense.
    expect(() =>
      as.token({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: client.client_id }),
    ).toThrow(/reuse detected|unknown or expired/);
  });

  test('refresh rotation: old token dies, reuse burns the family', async () => {
    const { as } = makeAs();
    const { client, verifier, code } = await fullFlow(as);
    const t1 = as.token({
      grant_type: 'authorization_code',
      code,
      client_id: client.client_id,
      redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
      code_verifier: verifier,
    });
    const t2 = as.token({ grant_type: 'refresh_token', refresh_token: t1.refresh_token, client_id: client.client_id });
    expect(t2.access_token).not.toBe(t1.access_token);
    // Reusing the rotated t1 refresh token burns the family — t2's refresh dies too.
    expect(() =>
      as.token({ grant_type: 'refresh_token', refresh_token: t1.refresh_token, client_id: client.client_id }),
    ).toThrow(/reuse detected/);
    expect(() =>
      as.token({ grant_type: 'refresh_token', refresh_token: t2.refresh_token, client_id: client.client_id }),
    ).toThrow(/expired|reuse|unknown/);
  });

  test('expired access tokens are refused by the resource verifier', async () => {
    const { as, keys } = makeAs();
    const { client, verifier, code } = await fullFlow(as);
    const tokens = as.token({
      grant_type: 'authorization_code',
      code,
      client_id: client.client_id,
      redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
      code_verifier: verifier,
    });
    clock += 16 * 60_000; // past the 15-min TTL
    const rsVerifier = new Es256TokenVerifier({ publicKey: keys.publicKey, issuer: ISSUER, audience: RESOURCE, now });
    expect(await rsVerifier.verify(tokens.access_token)).toMatchObject({ ok: false, reason: 'expired' });
  });

  test('a token signed by a DIFFERENT key is rejected', async () => {
    const { as } = makeAs();
    const { client, verifier, code } = await fullFlow(as);
    const tokens = as.token({
      grant_type: 'authorization_code',
      code,
      client_id: client.client_id,
      redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
      code_verifier: verifier,
    });
    const otherKeys = SigningKeys.ephemeral();
    const rsVerifier = new Es256TokenVerifier({ publicKey: otherKeys.publicKey, issuer: ISSUER, audience: RESOURCE, now });
    expect(await rsVerifier.verify(tokens.access_token)).toMatchObject({ ok: false, reason: 'bad_signature' });
  });
});

describe('Supabase identity delegation — tenant claim (Codex P1)', () => {
  const gotrue = (appMetadata: Record<string, unknown>) =>
    (async () => ({ ok: true, json: async () => ({ id: 'user-9', app_metadata: appMetadata }) })) as unknown as typeof fetch;

  test('reads the canonical active_tenant_id claim', async () => {
    const v = new SupabaseIdentityVerifier('https://sb.example', 'anon', gotrue({ active_tenant_id: 'tenant-x', tenant_id: 'stale' }));
    await expect(v.verify('t')).resolves.toEqual({ userId: 'user-9', tenantId: 'tenant-x' });
  });

  test('legacy tenant_id is tolerated when active_tenant_id is absent', async () => {
    const v = new SupabaseIdentityVerifier('https://sb.example', 'anon', gotrue({ tenant_id: 'tenant-legacy' }));
    await expect(v.verify('t')).resolves.toEqual({ userId: 'user-9', tenantId: 'tenant-legacy' });
  });

  test('a user with NO tenant claim is rejected — never silently elevated to platform', async () => {
    const v = new SupabaseIdentityVerifier('https://sb.example', 'anon', gotrue({}));
    await expect(v.verify('t')).resolves.toBeNull();
  });
});

describe('HTTP surface + end-to-end MCP call', () => {
  test('an AS-minted token authorizes a real MCP tools/list through the app', async () => {
    const { as, keys } = makeAs();
    const app = buildApp({
      backend: new MemoryReadBackend(),
      audit: new InMemoryAuditSink(),
      verifier: new Es256TokenVerifier({
        publicKey: keys.publicKey,
        issuer: ISSUER,
        audience: RESOURCE,
        revocations: { isRevoked: async (jti) => as.isJtiRevoked(jti) },
        now,
      }),
      resourceUrl: RESOURCE,
      authorizationServers: [ISSUER],
      authServer: as,
    });

    // Discovery endpoints are live on the same origin.
    const md = await request(app).get('/.well-known/oauth-authorization-server');
    expect(md.status).toBe(200);
    expect(md.body.jwks_uri).toBe(`${ISSUER}/oauth/jwks`);
    const jwks = await request(app).get('/oauth/jwks');
    expect(jwks.body.keys[0].alg).toBe('ES256');

    // DCR over HTTP.
    const reg = await request(app)
      .post('/oauth/register')
      .send({ client_name: 'HTTP Client', redirect_uris: ['https://claude.ai/cb'] });
    expect(reg.status).toBe(201);

    // Authorize 302s to the consent page.
    const { verifier: v, challenge } = pkce();
    const authz = await request(app).get('/oauth/authorize').query({
      client_id: reg.body.client_id,
      redirect_uri: 'https://claude.ai/cb',
      response_type: 'code',
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    expect(authz.status).toBe(302);
    expect(authz.headers.location).toContain(CONSENT);

    // Consent decision → code → token, over HTTP.
    const decision = await request(app).post('/oauth/authorize/decision').send({
      params: {
        client_id: reg.body.client_id,
        redirect_uri: 'https://claude.ai/cb',
        response_type: 'code',
        code_challenge: challenge,
        code_challenge_method: 'S256',
      },
      supabase_access_token: 'valid-supabase-token',
      approved: true,
    });
    expect(decision.status).toBe(200);
    const code = new URL(decision.body.redirect_to).searchParams.get('code')!;
    const tok = await request(app).post('/oauth/token').type('form').send({
      grant_type: 'authorization_code',
      code,
      client_id: reg.body.client_id,
      redirect_uri: 'https://claude.ai/cb',
      code_verifier: v,
    });
    expect(tok.status).toBe(200);

    // And the minted token drives a real MCP call.
    const mcp = await request(app)
      .post('/mcp')
      .set('Authorization', `Bearer ${tok.body.access_token}`)
      .set('Accept', 'application/json, text/event-stream')
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    expect(mcp.status).toBe(200);
    const tools = (mcp.body.result?.tools ?? []).map((t: { name: string }) => t.name);
    expect(tools).toContain('search_products');
  });

  test('registration is rate-limited per IP', async () => {
    const { as } = makeAs();
    const router = buildAuthServerRouter(as);
    const app = express().use(router);
    let last = 0;
    for (let i = 0; i < 35; i++) {
      const res = await request(app)
        .post('/oauth/register')
        .send({ client_name: `c${i}`, redirect_uris: ['https://x.example/cb'] });
      last = res.status;
    }
    expect(last).toBe(429);
  });
});
