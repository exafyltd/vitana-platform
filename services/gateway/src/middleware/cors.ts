import cors from "cors";
import { Express, Request, Response, NextFunction } from "express";

// VTID-01176: Allowed CORS origins for gateway
// vitana-dev-gateway is deprecated but kept for backward compatibility during transition
// VTID-01225: Added wildcard patterns for Lovable preview domains
const ALLOWED_ORIGINS = [
  "https://vitana-gateway-86804897789.us-central1.run.app",  // Canonical gateway
  "https://gateway-86804897789.us-central1.run.app",         // Short alias
  "https://gateway-q74ibpv6ia-uc.a.run.app",                 // Cloud Run generated
  "https://vitana-dev-gateway-86804897789.us-central1.run.app", // Deprecated redirector
  "https://id-preview--vitana-v1.lovable.app",               // Lovable preview (specific)
  "https://temp-vitana-v1.lovable.app",                      // Lovable temp domain
];

// VTID-01225: Patterns for dynamic Lovable preview domains
const ALLOWED_ORIGIN_PATTERNS = [
  /^https:\/\/[a-f0-9-]+\.lovableproject\.com$/,  // Lovable project previews (UUID format)
  /^https:\/\/.*\.lovable\.app$/,                  // All lovable.app subdomains
  /^https:\/\/.*--vitana-v1\.lovable\.app$/,       // Vitana-v1 branch previews
];

function isOriginAllowed(origin: string | undefined): boolean {
  if (!origin) return true; // Allow requests with no origin (e.g., server-to-server)

  // Check exact matches
  if (ALLOWED_ORIGINS.includes(origin)) return true;

  // Check pattern matches for dynamic Lovable domains
  for (const pattern of ALLOWED_ORIGIN_PATTERNS) {
    if (pattern.test(origin)) return true;
  }

  return false;
}

export const corsOptions = {
  origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
    if (isOriginAllowed(origin)) {
      callback(null, true);
    } else {
      console.warn(`[CORS] Blocked request from origin: ${origin}`);
      callback(new Error("Not allowed by CORS"));
    }
  },
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Authorization", "Content-Type", "apikey"],
  credentials: false,
  maxAge: 86400,
};

export function setupCors(app: Express) {
  app.use(cors(corsOptions));
  app.options("*", cors(corsOptions));
}

export function sseHeaders(req: Request, res: Response, next: NextFunction) {
  if (req.path.includes("/stream") || req.path.includes("/events")) {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
  }
  next();
}
