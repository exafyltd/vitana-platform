import { Request, Response, NextFunction, RequestHandler } from 'express';

export function limitPathParams(maxParams: number = 5, maxLength: number = 200): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    // 1. Validate route parameters if already parsed by Express inline
    const params = req.params || {};
    const keys = Object.keys(params);

    if (keys.length > maxParams) {
      res.status(400).json({ error: 'Too many path parameters or parameter too long' });
      return;
    }

    for (const key of keys) {
      const val = params[key];
      if (typeof val === 'string' && val.length > maxLength) {
        res.status(400).json({ error: 'Too many path parameters or parameter too long' });
        return;
      }
    }

    // 2. Validate raw path segments (Mitigates ReDoS before route matching)
    // This is crucial because standard router-level middleware executes before req.params 
    // are fully populated by the specific route handler. req.path drops the query string.
    const segments = req.path.split('/').filter(Boolean);
    
    // Count heuristic: allow a small buffer (+2) for structural base route segments
    if (segments.length > maxParams + 2) {
      res.status(400).json({ error: 'Too many path parameters or parameter too long' });
      return;
    }

    for (const segment of segments) {
      if (segment.length > maxLength) {
        res.status(400).json({ error: 'Too many path parameters or parameter too long' });
        return;
      }
    }

    next();
  };
}