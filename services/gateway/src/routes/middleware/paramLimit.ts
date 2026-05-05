import { Request, Response, NextFunction, RequestHandler } from 'express';

export function limitPathParams(maxParams: number = 5, maxLength: number = 200): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    // 1. Pre-route matching validation using req.path segments.
    // This protects against ReDoS in path-to-regexp before route handlers are invoked
    // by ensuring no single path segment can cause exponential backtracking.
    const segments = req.path.split('/').filter(Boolean);
    
    for (const segment of segments) {
      if (segment.length > maxLength) {
        res.status(400).json({ ok: false, error: 'Path parameter too long' });
        return;
      }
    }

    // 2. Validate parsed req.params if available 
    // (useful if middleware is mounted directly on a route rather than globally via router.use)
    if (req.params) {
      const keys = Object.keys(req.params);
      if (keys.length > maxParams) {
        res.status(400).json({ ok: false, error: 'Too many path parameters' });
        return;
      }

      for (const key of keys) {
        const val = req.params[key];
        if (typeof val === 'string' && val.length > maxLength) {
          res.status(400).json({ ok: false, error: 'Path parameter too long' });
          return;
        }
      }
    }

    next();
  };
}