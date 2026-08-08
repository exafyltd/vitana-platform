/**
 * Express app factory: /alive, OAuth protected-resource metadata (RFC 9728),
 * bearer auth, rate limiting, and the stateless MCP Streamable HTTP endpoint.
 *
 * Stateless JSON mode: one transport + server instance per request, so no
 * session state accumulates and horizontal scaling stays trivial.
 */
import express, { NextFunction, Request, Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { TokenVerifier } from './auth/token-verifier';
import { AuthContext } from './types';
import { ALL_SCOPES } from './auth/scopes';
import { RateLimiter } from './rate-limit';
import { buildMcpServerForAuth, ServerDeps } from './server';

export interface AppOptions extends ServerDeps {
  verifier: TokenVerifier;
  /** Canonical public resource URL, e.g. https://mcp.vitanaland.com/mcp */
  resourceUrl: string;
  /** Authorization server issuer URL(s) for discovery metadata. */
  authorizationServers: string[];
  rateLimiter?: RateLimiter;
}

interface AuthedRequest extends Request {
  meshAuth?: AuthContext;
}

export function buildApp(opts: AppOptions): express.Express {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  const limiter =
    opts.rateLimiter ?? new RateLimiter({ limitPerWindow: 120, windowMs: 60_000 });

  // Platform convention: /alive health endpoint.
  app.get('/alive', (_req, res) => {
    res.json({ ok: true, service: 'vcaop-mcp', ts: new Date().toISOString() });
  });

  // RFC 9728 protected-resource metadata — how MCP clients discover the AS.
  app.get('/.well-known/oauth-protected-resource', (_req, res) => {
    res.json({
      resource: opts.resourceUrl,
      authorization_servers: opts.authorizationServers,
      scopes_supported: ALL_SCOPES,
      bearer_methods_supported: ['header'],
      resource_documentation: 'https://vitanaland.com',
    });
  });

  const unauthorized = (res: Response, detail: string) => {
    res
      .status(401)
      .set(
        'WWW-Authenticate',
        `Bearer resource_metadata="${metadataUrlFor(opts.resourceUrl)}", error="invalid_token", error_description="${detail}"`,
      )
      .json({ error: { code: 'unauthorized', message: detail } });
  };

  // Bearer auth for the MCP endpoint.
  const authMiddleware = async (req: AuthedRequest, res: Response, next: NextFunction) => {
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return unauthorized(res, 'Missing bearer token');
    const result = await opts.verifier.verify(token);
    if (!result.ok || !result.context) {
      return unauthorized(res, `Token rejected (${result.reason ?? 'unknown'})`);
    }
    req.meshAuth = result.context;
    next();
  };

  const rateLimitMiddleware = (req: AuthedRequest, res: Response, next: NextFunction) => {
    const key = `${req.meshAuth!.tenantId}:${req.meshAuth!.userId}:${req.meshAuth!.clientId}`;
    if (!limiter.allow(key)) {
      res
        .status(429)
        .set('Retry-After', '60')
        .json({ error: { code: 'rate_limited', message: 'Too many requests. Retry after 60s.' } });
      return;
    }
    next();
  };

  app.post('/mcp', authMiddleware, rateLimitMiddleware, async (req: AuthedRequest, res) => {
    const server = buildMcpServerForAuth(opts, req.meshAuth!);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  // MCP Streamable HTTP: GET/DELETE are session operations — stateless mode refuses them.
  app.get('/mcp', authMiddleware, (_req, res) => {
    res.status(405).json({ error: { code: 'invalid_input', message: 'Stateless server: POST only.' } });
  });
  app.delete('/mcp', authMiddleware, (_req, res) => {
    res.status(405).json({ error: { code: 'invalid_input', message: 'Stateless server: POST only.' } });
  });

  return app;
}

function metadataUrlFor(resourceUrl: string): string {
  const u = new URL(resourceUrl);
  return `${u.origin}/.well-known/oauth-protected-resource`;
}
