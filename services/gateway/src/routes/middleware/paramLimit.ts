import { Request, Response, NextFunction, RequestHandler } from 'express';

export function limitPathParams(maxParams = 5, maxLength = 200): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    // 1. Check parsed params if populated (e.g., when applied directly to a route handler)
    if (req.params) {
      const keys = Object.keys(req.params);
      
      if (keys.length > maxParams) {
        res.status(400).json({ error: 'Too many path parameters or parameter too long' });
        return;
      }

      for (const key of keys) {
        const val = req.params[key];
        if (val && typeof val === 'string' && val.length > maxLength) {
          res.status(400).json({ error: 'Too many path parameters or parameter too long' });
          return;
        }
      }
    }

    // 2. Check raw path segments as a fallback (e.g., when applied via router.use() 
    // where req.params is not yet populated by the matched route).
    const pathSegments = req.path.split('/').filter(Boolean);
    
    for (const segment of pathSegments) {
      // Use simple length check rather than RegExp for validation to avoid any ReDoS risk
      if (segment.length > maxLength) {
        res.status(400).json({ error: 'Too many path parameters or parameter too long' });
        return;
      }
    }

    // Proxy check for total segments to avoid deep path traversal attacks.
    // We add a generous buffer (10) for static path segments.
    if (pathSegments.length > maxParams + 10) {
      res.status(400).json({ error: 'Too many path parameters or parameter too long' });
      return;
    }

    next();
  };
}