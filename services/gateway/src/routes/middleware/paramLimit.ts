import { Request, Response, NextFunction, RequestHandler } from 'express';

export function limitPathParams(maxParams: number = 5, maxLength: number = 200): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    // 1. Pre-validation of path segments to prevent ReDoS before route parameter matching occurs.
    // We split by '/' using RegExp directly, avoiding the vulnerable path-to-regexp engine.
    const pathSegments = req.path.split(/\//).filter(Boolean);
    for (const segment of pathSegments) {
      if (segment.length > maxLength) {
        res.status(400).json({ ok: false, error: 'Too many path parameters or parameter too long' });
        return;
      }
    }

    // 2. Validation of parsed route parameters (if the middleware is mounted where params are populated)
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