import { Request, Response, NextFunction, RequestHandler } from 'express';

export function limitPathParams(maxParams = 5, maxLength = 200): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    // 1. Strict limit on parsed path parameters 
    // (Used when the middleware runs directly on a matched route)
    const keys = Object.keys(req.params);
    if (keys.length > maxParams) {
      res.status(400).json({ ok: false, error: 'Too many path parameters' });
      return;
    }

    for (const key of keys) {
      if (req.params[key] && req.params[key].length > maxLength) {
        res.status(400).json({ ok: false, error: 'Path parameter too long' });
        return;
      }
    }

    // 2. Pre-check on raw path segments 
    // (Runs when middleware is applied globally via router.use(), stopping ReDoS 
    // before the vulnerable path-to-regexp compilation/matching is executed)
    const segments = req.path.split('/').filter(Boolean);
    
    for (const segment of segments) {
      if (segment.length > maxLength) {
        res.status(400).json({ ok: false, error: 'Path parameter too long' });
        return;
      }
    }

    // Apply a generous upper bound for total segments to avoid blocking valid deep 
    // REST routes while stopping extreme backtracking paths.
    if (segments.length > Math.max(maxParams + 10, 20)) {
      res.status(400).json({ ok: false, error: 'Too many path parameters' });
      return;
    }

    next();
  };
}