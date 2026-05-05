import { Request, Response, NextFunction, RequestHandler } from 'express';

export function limitPathParams(maxParams = 5, maxLength = 200): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    // 1. Mitigate ReDoS by validating the raw path before Express route matching completes.
    // This prevents deep path backtracking before path-to-regexp parses the route.
    const rawPath = req.originalUrl ? req.originalUrl.split('?')[0] : req.url.split('?')[0];
    const segments = rawPath.split('/').filter(Boolean);
    
    // Check lengths of raw segments
    for (const segment of segments) {
      if (segment.length > maxLength) {
        res.status(400).json({ ok: false, error: 'Too many path parameters or parameter too long' });
        return;
      }
    }

    // Heuristic: If an attacker sends deeply nested paths to trigger backtracking, reject it.
    // Allows maxParams + a sensible buffer for static API prefixes (e.g., api/v1/users).
    if (segments.length > maxParams + 5) {
      res.status(400).json({ ok: false, error: 'Too many path parameters or parameter too long' });
      return;
    }

    // 2. Validate explicit req.params (covers cases when mounted as route-level middleware)
    if (req.params) {
      const keys = Object.keys(req.params);
      if (keys.length > maxParams) {
        res.status(400).json({ ok: false, error: 'Too many path parameters or parameter too long' });
        return;
      }
      
      for (const key of keys) {
        const val = req.params[key];
        if (val && typeof val === 'string' && val.length > maxLength) {
          res.status(400).json({ ok: false, error: 'Too many path parameters or parameter too long' });
          return;
        }
      }
    }
    
    next();
  };
}