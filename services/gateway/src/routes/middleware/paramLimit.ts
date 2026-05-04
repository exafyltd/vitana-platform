import { Request, Response, NextFunction, RequestHandler } from 'express';

export function limitPathParams(maxParams: number = 5, maxLength: number = 200): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    // 1. Defend against ReDoS before route matching (when mounted via router.use).
    // By checking the raw URL path, we can short-circuit the request before Express 
    // parses it with vulnerable path-to-regexp versions.
    if (req.path) {
      // Use simple string splitting to validate segments without complex RegExp
      const pathSegments = req.path.split(/\/+/).filter(Boolean);
      
      for (const segment of pathSegments) {
        if (segment.length > maxLength) {
          return res.status(400).json({ ok: false, error: 'Too many path parameters or parameter too long' });
        }
      }

      // Cap the total number of segments. maxParams applies to parameters, 
      // so we add a safe buffer (e.g. 10) for static route prefixes.
      if (pathSegments.length > maxParams + 10) {
        return res.status(400).json({ ok: false, error: 'Too many path parameters or parameter too long' });
      }
    }

    // 2. Check req.params if available (when mounted directly on a route).
    if (req.params) {
      const keys = Object.keys(req.params);
      if (keys.length > maxParams) {
        return res.status(400).json({ ok: false, error: 'Too many path parameters or parameter too long' });
      }
      
      for (const key of keys) {
        if (req.params[key] && req.params[key].length > maxLength) {
          return res.status(400).json({ ok: false, error: 'Too many path parameters or parameter too long' });
        }
      }
    }

    next();
  };
}