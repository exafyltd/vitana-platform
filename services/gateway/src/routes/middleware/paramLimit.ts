import { Request, Response, NextFunction, RequestHandler } from 'express';

export function limitPathParams(maxParams: number = 5, maxLength: number = 200): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    // 1. Direct validation if req.params is populated
    // Works when middleware is applied at the specific route level.
    if (req.params) {
      const keys = Object.keys(req.params);
      if (keys.length > maxParams) {
        res.status(400).json({ ok: false, error: 'Too many path parameters or parameter too long' });
        return;
      }

      for (const key of keys) {
        const val = req.params[key];
        if (val && val.length > maxLength) {
          res.status(400).json({ ok: false, error: 'Too many path parameters or parameter too long' });
          return;
        }
      }
    }

    // 2. Global path validation (fallback) to prevent ReDoS during route matching
    // Protects routes when the middleware is mounted via app.use() or router.use() before route match.
    try {
      const decodedPath = decodeURIComponent(req.path);
      const segments = decodedPath.split('/').filter(Boolean);
      
      // Allow leeway (e.g., +5) for static base path segments (e.g. /api/v1/resource/...)
      if (segments.length > maxParams + 5) {
        res.status(400).json({ ok: false, error: 'Too many path parameters or parameter too long' });
        return;
      }

      for (const segment of segments) {
        if (segment.length > maxLength) {
          res.status(400).json({ ok: false, error: 'Too many path parameters or parameter too long' });
          return;
        }
      }
    } catch (e) {
      // Fallback if decodeURIComponent fails on malformed input
      res.status(400).json({ ok: false, error: 'Invalid URL encoding' });
      return;
    }

    next();
  };
}