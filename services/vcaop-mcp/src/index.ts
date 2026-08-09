/**
 * Entry point (dev/staging only — public exposure is gated on BLK-006).
 *
 * Backend selection:
 *   MESH_BACKEND=memory (default) — synthetic fixtures, no external calls.
 *   MESH_BACKEND=gateway          — dev wiring against the live gateway's
 *                                   verified /api/v1/vcaop/* endpoints.
 *
 * Auth (BLK-007, resolved 2026-08-09 — embedded OAuth 2.1 AS):
 *   MCP_AS_ENABLED=true  → the embedded authorization server mounts on the
 *   same origin (RFC 8414 metadata, RFC 7591 DCR, authorize+PKCE, token,
 *   jwks); tokens are ES256 and verified by Es256TokenVerifier. End-user
 *   identity delegates to Supabase Auth (SUPABASE_URL + SUPABASE_ANON_KEY).
 *   The ES256 private key comes from MCP_AS_SIGNING_KEY_PEM (a secret
 *   REFERENCE resolved by the runtime); absent, an EPHEMERAL key is
 *   generated with a loud warning — dev only, restart invalidates tokens.
 *
 *   MCP_AS_ENABLED unset → legacy dev/test mode: HS256 shared-secret
 *   verification via MCP_TEST_AS_HS256_SECRET (spec-shaped test AS).
 */
import { buildApp } from './app';
import {
  Es256TokenVerifier,
  HmacTokenVerifier,
  InMemoryRevocationStore,
  TokenVerifier,
} from './auth/token-verifier';
import { SigningKeys } from './auth/keys';
import { AuthorizationServer, SupabaseIdentityVerifier } from './auth/authorization-server';
import { MemoryReadBackend } from './backend/memory-backend';
import { GatewayReadBackend } from './backend/gateway-backend';
import { ConsoleAuditSink } from './audit/audit-sink';
import { MeshReadBackend } from './backend/read-backend';

function main(): void {
  const resourceUrl = process.env.MCP_RESOURCE_URL ?? 'http://localhost:8080/mcp';
  const issuer = process.env.MCP_AS_ISSUER ?? new URL(resourceUrl).origin;

  let verifier: TokenVerifier;
  let authServer: AuthorizationServer | undefined;
  let authorizationServers: string[];

  if (process.env.MCP_AS_ENABLED === 'true') {
    const pem = process.env.MCP_AS_SIGNING_KEY_PEM;
    let keys: SigningKeys;
    if (pem) {
      keys = SigningKeys.fromPem(pem);
    } else {
      keys = SigningKeys.ephemeral();
      console.warn(
        '[vcaop-mcp] WARNING: MCP_AS_SIGNING_KEY_PEM not set — using an EPHEMERAL signing key. ' +
          'Every outstanding token dies on restart. Dev only.',
      );
    }
    const supabaseUrl = process.env.SUPABASE_URL;
    const anonKey = process.env.SUPABASE_ANON_KEY;
    if (!supabaseUrl || !anonKey) {
      console.error('FATAL: MCP_AS_ENABLED=true requires SUPABASE_URL and SUPABASE_ANON_KEY for end-user identity.');
      process.exit(1);
    }
    authServer = new AuthorizationServer({
      issuer,
      resourceUrl,
      consentUrl: process.env.MCP_AS_CONSENT_URL ?? 'https://vitanaland.com/oauth/consent',
      keys,
      identity: new SupabaseIdentityVerifier(supabaseUrl, anonKey),
    });
    const asRef = authServer;
    verifier = new Es256TokenVerifier({
      publicKey: keys.publicKey,
      issuer,
      audience: resourceUrl,
      revocations: { isRevoked: async (jti) => asRef.isJtiRevoked(jti) },
    });
    authorizationServers = [issuer];
  } else {
    const secret = process.env.MCP_TEST_AS_HS256_SECRET;
    if (!secret) {
      console.error(
        'FATAL: set MCP_AS_ENABLED=true (embedded AS) or MCP_TEST_AS_HS256_SECRET (dev/test HS256). ' +
          'Refusing to start without token verification — this server is never unauthenticated.',
      );
      process.exit(1);
    }
    verifier = new HmacTokenVerifier({
      secret,
      audience: resourceUrl,
      revocations: new InMemoryRevocationStore(),
    });
    authorizationServers = (process.env.MCP_AUTHORIZATION_SERVERS ?? 'http://localhost:9000')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }

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
    verifier,
    resourceUrl,
    authorizationServers,
    authServer,
  });

  const port = parseInt(process.env.PORT ?? '8080', 10);
  app.listen(port, () => {
    console.log(
      `[vcaop-mcp] listening on :${port} (backend=${process.env.MESH_BACKEND ?? 'memory'}, as=${authServer ? 'embedded' : 'external-dev'})`,
    );
  });
}

main();
