/** Shared test helpers. Synthetic data only — no real PII or credentials. */
import express from 'express';
import request from 'supertest';
import { buildApp } from '../src/app';
import {
  HmacTokenVerifier,
  InMemoryRevocationStore,
  mintHs256Token,
} from '../src/auth/token-verifier';
import { MemoryReadBackend } from '../src/backend/memory-backend';
import { InMemoryAuditSink } from '../src/audit/audit-sink';
import { RateLimiter } from '../src/rate-limit';
import { ALL_SCOPES } from '../src/auth/scopes';

export const TEST_SECRET = 'test-as-secret-not-a-real-credential';
export const RESOURCE_URL = 'http://localhost:8080/mcp';

export interface TestHarness {
  app: express.Express;
  audit: InMemoryAuditSink;
  revocations: InMemoryRevocationStore;
}

export function makeHarness(opts?: { rateLimiter?: RateLimiter }): TestHarness {
  const audit = new InMemoryAuditSink();
  const revocations = new InMemoryRevocationStore();
  const app = buildApp({
    backend: new MemoryReadBackend(),
    audit,
    verifier: new HmacTokenVerifier({
      secret: TEST_SECRET,
      audience: RESOURCE_URL,
      revocations,
    }),
    resourceUrl: RESOURCE_URL,
    authorizationServers: ['http://localhost:9000'],
    rateLimiter: opts?.rateLimiter,
  });
  return { app, audit, revocations };
}

export function mintToken(overrides: Record<string, unknown> = {}): string {
  return mintHs256Token(TEST_SECRET, {
    iss: 'http://localhost:9000',
    sub: 'tenant-a-user-1',
    tenant_id: 'tenant-a',
    client_id: 'client-test',
    aud: RESOURCE_URL,
    scope: ALL_SCOPES.join(' '),
    exp: Math.floor(Date.now() / 1000) + 3600,
    iat: Math.floor(Date.now() / 1000),
    jti: `jti-${Math.random().toString(36).slice(2)}`,
    ...overrides,
  });
}

let rpcId = 0;

/** POST a JSON-RPC message to /mcp with proper MCP Accept headers. */
export async function rpc(
  app: express.Express,
  token: string | null,
  body: Record<string, unknown>,
): Promise<request.Response> {
  let req = request(app)
    .post('/mcp')
    .set('Accept', 'application/json, text/event-stream')
    .set('Content-Type', 'application/json');
  if (token) req = req.set('Authorization', `Bearer ${token}`);
  return req.send(body);
}

export function initializeBody(): Record<string, unknown> {
  return {
    jsonrpc: '2.0',
    id: ++rpcId,
    method: 'initialize',
    params: {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'test-client', version: '0.0.1' },
    },
  };
}

export function toolsListBody(): Record<string, unknown> {
  return { jsonrpc: '2.0', id: ++rpcId, method: 'tools/list', params: {} };
}

export function toolsCallBody(
  name: string,
  args: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    jsonrpc: '2.0',
    id: ++rpcId,
    method: 'tools/call',
    params: { name, arguments: args },
  };
}

/** Extract the stable error envelope from a tools/call result. */
export function toolErrorOf(body: any): { code: string; message: string } | null {
  const result = body?.result;
  if (!result?.isError) return null;
  try {
    return JSON.parse(result.content?.[0]?.text ?? '{}').error ?? null;
  } catch {
    return null;
  }
}
