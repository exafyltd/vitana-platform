import cors from "cors";
import { Express, Request, Response, NextFunction } from "express";

// VTID-01176: Allowed CORS origins for gateway
// vitana-dev-gateway is deprecated but kept for backward compatibility during transition
const ALLOWED_ORIGINS = [
  "https://vitana-gateway-86804897789.us-central1.run.app",  // Canonical gateway
  "https://gateway-86804897789.us-central1.run.app",         // Short alias
  "https://gateway-q74ibpv6ia-uc.a.run.app",                 // Cloud Run generated
  "https://vitana-dev-gateway-86804897789.us-central1.run.app", // Deprecated redirector
  "https://id-preview--vitana-v1.lovable.app",               // Lovable preview
];

export const corsOptions = {
  origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
    if (!origin || ALLOWED_ORIGINS.includes(origin)) {
      callback(null, true);
    } else {
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
