/**
 * Entry point (dev/staging only — public exposure is gated on BLK-006/BLK-007).
 *
 * Backend selection:
 *   MESH_BACKEND=memory (default) — synthetic fixtures, no external calls.
 *   MESH_BACKEND=gateway          — dev wiring against the live gateway's
 *                                   verified /api/v1/vcaop/* endpoints.
 *
 * Token verification (dev/test AS only): MCP_TEST_AS_HS256_SECRET must be set;
 * the production verifier (JWKS against the approved AS) replaces
 * HmacTokenVerifier behind the same interface once BLK-007 is decided.
 */
import { buildApp } from './app';
import { HmacTokenVerifier, InMemoryRevocationStore } from './auth/token-verifier';
import { MemoryReadBackend } from './backend/memory-backend';
import { GatewayReadBackend } from './backend/gateway-backend';
import { ConsoleAuditSink } from './audit/audit-sink';
import { MeshReadBackend } from './backend/read-backend';

function main(): void {
  const secret = process.env.MCP_TEST_AS_HS256_SECRET;
  if (!secret) {
    console.error(
      'FATAL: MCP_TEST_AS_HS256_SECRET is required (dev/test token verification). ' +
        'Refusing to start without token verification — this server is never unauthenticated.',
    );
    process.exit(1);
  }

  const resourceUrl = process.env.MCP_RESOURCE_URL ?? 'http://localhost:8080/mcp';
  const authorizationServers = (process.env.MCP_AUTHORIZATION_SERVERS ?? 'http://localhost:9000')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  let backend: MeshReadBackend;
  if (process.env.MESH_BACKEND === 'gateway') {
    const baseUrl = process.env.VCAOP_GATEWAY_URL;
    const upstreamToken = process.env.VCAOP_GATEWAY_TOKEN_REF; // reference resolved by the runtime env, never a literal in code
    if (!baseUrl || !upstreamToken) {
      console.error('FATAL: MESH_BACKEND=gateway requires VCAOP_GATEWAY_URL and VCAOP_GATEWAY_TOKEN_REF.');
      process.exit(1);
    }
    backend = new GatewayReadBackend({
      baseUrl,
      getUpstreamToken: async () => upstreamToken,
    });
  } else {
    backend = new MemoryReadBackend();
  }

  const app = buildApp({
    backend,
    audit: new ConsoleAuditSink(),
    verifier: new HmacTokenVerifier({
      secret,
      audience: resourceUrl,
      revocations: new InMemoryRevocationStore(),
    }),
    resourceUrl,
    authorizationServers,
  });

  const port = parseInt(process.env.PORT ?? '8080', 10);
  app.listen(port, () => {
    console.log(`[vcaop-mcp] listening on :${port} (backend=${process.env.MESH_BACKEND ?? 'memory'})`);
  });
}

main();
