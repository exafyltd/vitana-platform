import { Request, Response, NextFunction, RequestHandler } from 'express';

export function limitPathParams(maxParams: number = 5, maxLength: number = 200): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    // 1. Defensively validate raw path segments before vulnerable path-to-regexp executes.
    // This prevents ReDoS caused by exponentially evaluated long strings in the URL path.
    const pathSegments = req.path.split('/').filter(Boolean);
    for (const segment of pathSegments) {
      if (segment.length > maxLength) {
        res.status(400).json({ ok: false, error: 'Too many path parameters or parameter too long' });
        return;
      }
    }

    // 2. Parse req.params and count its keys as per the mitigation plan.
    // (This is primarily effective when the middleware is applied at the route-level rather than globally).
    if (req.params) {
      const keys = Object.keys(req.params);
      if (keys.length > maxParams) {
        res.status(400).json({ ok: false, error: 'Too many path parameters or parameter too long' });
        return;
      }
      for (const key of keys) {
        if (req.params[key] && req.params[key].length > maxLength) {
          res.status(400).json({ ok: false, error: 'Too many path parameters or parameter too long' });
          return;
        }
      }
    }

    next();
  };
}