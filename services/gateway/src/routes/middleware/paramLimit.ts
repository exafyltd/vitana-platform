import { Request, Response, NextFunction, RequestHandler } from 'express';

/**
 * Middleware to mitigate CVE-2024-3651 (ReDoS in path-to-regexp).
 * Limits the number and length of path parameters.
 * Runs validation on both `req.params` (if populated by router)
 * and the raw `req.path` segments (to protect against ReDoS prior to route matching).
 */
export function limitPathParams(maxParams: number = 5, maxLength: number = 200): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    // 1. Check req.params if already populated (e.g. inline middleware)
    const params = req.params || {};
    const keys = Object.keys(params);

    if (keys.length > maxParams) {
      res.status(400).json({ ok: false, error: 'Too many path parameters or parameter too long' });
      return;
    }

    for (const key of keys) {
      const value = params[key];
      if (value && value.length > maxLength) {
        res.status(400).json({ ok: false, error: 'Too many path parameters or parameter too long' });
        return;
      }
    }

    // 2. Fallback check on raw URL path segments to prevent ReDoS before route matching
    // occurs in Express's vulnerable path-to-regexp router.
    const pathSegments = req.path.split('/').filter(Boolean);

    // Using maxParams + 10 to account for static segments in typical REST prefixes
    if (pathSegments.length > maxParams + 10) {
      res.status(400).json({ ok: false, error: 'Too many path parameters or parameter too long' });
      return;
    }

    for (const segment of pathSegments) {
      if (segment.length > maxLength) {
        res.status(400).json({ ok: false, error: 'Too many path parameters or parameter too long' });
        return;
      }
    }

    next();
  };
}