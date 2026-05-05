import { Request, Response, NextFunction, RequestHandler } from 'express';

export function limitPathParams(maxParams = 5, maxLength = 200): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    // 1. Pre-emptive check on the raw URL path to avoid path-to-regexp ReDoS
    // This runs before route matching when mounted via app.use() or router.use()
    const pathSegments = req.path.split('/').filter(Boolean);
    
    for (const segment of pathSegments) {
      if (segment.length > maxLength) {
        res.status(400).json({ ok: false, error: 'Path parameter too long' });
        return;
      }
    }

    // Heuristic: If there are more segments than maxParams + 3 (assuming up to 3 static segments), reject.
    if (pathSegments.length > maxParams + 3) {
      res.status(400).json({ ok: false, error: 'Too many path parameters' });
      return;
    }

    // 2. Check Express req.params if already parsed (e.g., when used as route-level middleware)
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