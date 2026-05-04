import { Request, Response, NextFunction, RequestHandler } from 'express';

export function limitPathParams(maxParams = 5, maxLength = 200): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    // 1. Check req.params if already populated (e.g., if applied directly on a matched route)
    const params = req.params || {};
    const keys = Object.keys(params);

    if (keys.length > maxParams) {
      res.status(400).json({ ok: false, error: 'Too many path parameters' });
      return;
    }

    for (const key of keys) {
      const val = params[key];
      if (val && typeof val === 'string' && val.length > maxLength) {
        res.status(400).json({ ok: false, error: 'Path parameter too long' });
        return;
      }
    }

    // 2. Pre-emptive ReDoS Mitigation
    // When applied via router.use(), req.params is empty before route matching occurs.
    // We inspect the raw URL segments to protect against path-to-regexp backtracking.
    const path = req.path || '';
    const segments = path.split('/').filter(Boolean);
    
    for (const segment of segments) {
      if (segment.length > maxLength) {
        res.status(400).json({ ok: false, error: 'Path parameter too long' });
        return;
      }
    }

    // Provide a buffer for base static paths (e.g., /api/v1/projects) 
    if (segments.length > maxParams + 10) {
      res.status(400).json({ ok: false, error: 'Too many path parameters' });
      return;
    }

    next();
  };
}