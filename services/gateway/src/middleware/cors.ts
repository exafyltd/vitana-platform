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

export function setupCors(app: Express) {
  app.use(cors(corsOptions));
  app.options("*", cors(corsOptions));
}

export function sseHeaders(req: Request, res: Response, next: NextFunction) {
  // Only apply SSE headers to actual GET /stream endpoints, NOT POST /stream/send or /stream/end-turn.
  // The old check (path.includes("/stream")) incorrectly matched /live/stream/send POST requests,
  // setting text/event-stream content-type on JSON POST responses.
  if (req.method === 'GET' && (req.path.includes("/stream") || req.path.includes("/events"))) {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
  }
  next();
}
