import cors from "cors";
import { Express, Request, Response, NextFunction } from "express";

// VTID-01176: Allowed CORS origins for gateway
// VTID-01226: Added Lovable dynamic origins (*.lovableproject.com, *.lovable.app)
// vitana-dev-gateway is deprecated but kept for backward compatibility during transition
const ALLOWED_ORIGINS = [
  "https://vitana-gateway-86804897789.us-central1.run.app",  // Canonical gateway
  "https://gateway-86804897789.us-central1.run.app",         // Short alias
  "https://gateway-q74ibpv6ia-uc.a.run.app",                 // Cloud Run generated
  "https://gateway.vitanaland.com",                            // Cloudflare-fronted custom gateway domain (BOOTSTRAP-CLOUDFLARE-GATEWAY-DOMAIN)
  "https://vitana-dev-gateway-86804897789.us-central1.run.app", // Deprecated redirector
  "https://community-app-86804897789.us-central1.run.app",    // Community app on Cloud Run
  "https://community-app-q74ibpv6ia-uc.a.run.app",           // Community app Cloud Run alias
  "https://id-preview--vitana-v1.lovable.app",               // Lovable preview
  "https://vitanaland.com",                                    // Production custom domain (mobile app)
  "https://www.vitanaland.com",                                // Production custom domain (www)
  "https://preview.vitanaland.com",                            // Staging frontend (community-app-staging) — staging-first cutover
  // BOOTSTRAP-STAGING-GATEWAY-CORS: the staging gateway's OWN domains. The
  // Command Hub on preview-gateway.vitanaland.com POSTs same-origin, and
  // browsers send an Origin header on every POST — without these entries the
  // cors callback errors and Express answers with an HTML 500, which broke
  // login on staging while curl (no Origin header) looked healthy.
  "https://preview-gateway.vitanaland.com",                    // Staging gateway custom domain (Command Hub)
  "https://gateway-staging-q74ibpv6ia-uc.a.run.app",           // Staging gateway Cloud Run URL
  // BOOTSTRAP-AWS-STAGING-VALIDATION: AWS staging stack (eu-central-1 ALB).
  // Frontend origin, plus the gateway's OWN domain for Command Hub
  // same-origin POSTs (same reasoning as BOOTSTRAP-STAGING-GATEWAY-CORS
  // above for the GCP staging domains).
  "https://preview-aws.vitanaland.com",                        // AWS staging frontend
  "https://preview-aws-gateway.vitanaland.com",                // AWS staging gateway (Command Hub)
  // VTID-03398: AWS production (DR) stack. Same reasoning as the AWS
  // staging entries above — without these, the cors callback errors and
  // Express answers with an HTML 500 instead of a JSON response, which
  // breaks login (this exact failure mode already happened twice before:
  // GCP staging, then AWS staging).
  "https://dr-app.vitanaland.com",                             // AWS production DR frontend (community-app-awsdr)
  "https://dr-gateway.vitanaland.com",                         // AWS production DR gateway (Command Hub same-origin POSTs)
];

// VTID-01226: Dynamic origin patterns for Lovable-hosted frontends
// VTID-NAV-HOTFIX3: Also allow any Cloud Run community-app revision URL so
// future deploys don't break CORS when the revision hash in the hostname
// changes (e.g. community-app-00030-abc.run.app).
const ALLOWED_ORIGIN_PATTERNS = [
  /^https:\/\/[a-z0-9-]+\.lovableproject\.com$/,  // Lovable project previews
  /^https:\/\/[a-z0-9-]+\.lovable\.app$/,         // Lovable app domains
  /^https:\/\/community-app[a-z0-9-]*\.run\.app$/,           // Cloud Run revision aliases
  /^https:\/\/community-app[a-z0-9-]*\.us-central1\.run\.app$/, // Cloud Run full URLs
];

function isOriginAllowed(origin: string): boolean {
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  return ALLOWED_ORIGIN_PATTERNS.some(pattern => pattern.test(origin));
}

export const corsOptions = {
  origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
    if (!origin || isOriginAllowed(origin)) {
      callback(null, true);
    } else {
      console.warn(`[CORS] Blocked origin: ${origin}`);
      callback(new Error("Not allowed by CORS"));
    }
  },
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Authorization", "Content-Type", "apikey", "X-Vitana-Active-Role", "X-Vitana-Tenant", "X-Vitana-User", "X-User-ID"],
  // VTID-02036: REVERTED VTID-02034. With credentials:true the browser
  // requires Access-Control-Allow-Credentials on every response and
  // the SSE/EventSource path on iOS Safari interacted poorly with it.
  // Restoring credentials:false; cross-origin requests carry no cookies.
  credentials: false,
  maxAge: 86400,
};

// VTID-05079: OpenAI's plugin portal reads our OAuth discovery documents and talks to the
// ChatGPT MCP endpoint from the browser (Origin: https://platform.openai.com). The generic
// handler above answers any origin that is not on its allow-list with an HTML 500, so the
// portal reported "Authorization unavailable" and never started the sign-in. Two narrow
// rules, exact paths only, and nothing else widened (/mcp, /api/*, the Command Hub keep the
// allow-list above):
//   1. GET/HEAD/OPTIONS on /.well-known/*: public, unauthenticated discovery documents, any
//      origin (`*`, no credentials).
//   2. /mcp/chatgpt: only the OpenAI origins below, reflected exactly (never `*`). The bearer
//      token is still required for any data; CORS only lets those pages read the response,
//      including the WWW-Authenticate challenge that points at the sign-in metadata.
const OPENAI_MCP_ORIGINS = ["https://platform.openai.com", "https://chatgpt.com"];
// VTID-05133: the Maxina Community connector's ChatGPT path gets the same exact-path rule.
const MCP_CHATGPT_PATHS = ["/mcp/chatgpt", "/mcp/community/chatgpt"];
const WELL_KNOWN_PREFIX = "/.well-known/";

/**
 * Applies the narrow CORS rules above. Returns true when the request was handled by one of
 * them (headers set, preflight answered), false when the generic handler must decide.
 * Exported for tests.
 */
export function applyDiscoveryCors(req: Request, res: Response): boolean {
  const path = req.path;
  const method = req.method.toUpperCase();
  const origin = req.headers.origin;

  if (path.startsWith(WELL_KNOWN_PREFIX) && ["GET", "HEAD", "OPTIONS"].includes(method)) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept");
    res.setHeader("Access-Control-Max-Age", "86400");
    return true;
  }

  if (MCP_CHATGPT_PATHS.includes(path) && ["POST", "OPTIONS"].includes(method) && typeof origin === "string" && OPENAI_MCP_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, Accept, Mcp-Protocol-Version, Mcp-Session-Id");
    res.setHeader("Access-Control-Expose-Headers", "WWW-Authenticate, Mcp-Session-Id");
    res.setHeader("Access-Control-Max-Age", "86400");
    return true;
  }

  return false;
}

export function setupCors(app: Express) {
  const generic = cors(corsOptions);
  // Registered BEFORE the generic handler, which it bypasses for the two path rules only.
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (applyDiscoveryCors(req, res)) {
      if (req.method.toUpperCase() === "OPTIONS") return res.sendStatus(204);
      return next();
    }
    return generic(req, res, next);
  });
  app.options("*", cors(corsOptions));
}

export function sseHeaders(req: Request, res: Response, next: NextFunction) {
  // Only apply SSE headers to actual GET /stream endpoints, NOT POST /stream/send or /stream/end-turn.
  // The old check (path.includes("/stream")) incorrectly matched /live/stream/send POST requests,
  // setting text/event-stream content-type on JSON POST responses.
  // VTID-04615: never on Command Hub pages. Its screens include
  // /command-hub/oasis/events/ and /command-hub/oasis/streams/, and the
  // browser would not render HTML served as text/event-stream. No SSE route
  // lives under /command-hub; its streams are all under /api/v1.
  if (req.path === '/command-hub' || req.path.startsWith('/command-hub/')) return next();
  // VTID-04680: the calendar API serves JSON on GET /api/v1/calendar/events...
  // (list, window, one event) and has no stream; "/events" in its path is not
  // an SSE route. Labelling those replies text/event-stream failed the
  // STAGING-VERIFY content-type check on the calendar window route.
  if (req.path === '/api/v1/calendar' || req.path.startsWith('/api/v1/calendar/')) return next();
  // VTID-05065: the Kiro run stream (GET /api/v1/operator/kiro/runs/:id/stream) sets its own
  // SSE headers after requireAdminAuth; labelling its 401/403/404 JSON replies text/event-stream
  // failed STAGING-VERIFY ("expected application/json").
  if (req.path.startsWith('/api/v1/operator/kiro/runs/')) return next();
  // VTID-05069: the same for the pipeline-tree stream (GET /api/v1/operator/runs/:vtid/stream).
  if (req.path.startsWith('/api/v1/operator/runs/')) return next();
  // VTID-04695: "/events" alone is not a stream. Every GET under /events is
  // a JSON route (OASIS events, universal-cart, product analytics,
  // voice-lab debug; calendar is exempted above) and res.json() keeps a Content-Type already
  // set, so they were served as text/event-stream (STAGING-VERIFY, calendar
  // window 401). A path under /events is treated as a stream only when the
  // client asks for one — EventSource always sends that Accept header.
  const wantsStream = String(req.headers.accept || '').includes('text/event-stream');
  if (req.method === 'GET' && (req.path.includes("/stream") || (req.path.includes("/events") && wantsStream))) {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
  }
  next();
}
