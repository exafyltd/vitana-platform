import { Request, Response, NextFunction, RequestHandler } from 'express';

/**
 * Middleware to mitigate path-to-regexp ReDoS by limiting the number 
 * and length of path parameters.
 */
export function limitPathParams(maxParams: number = 5, maxLength: number = 200): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    // 1. Check req.params if already populated (e.g. applied at route-level)
    const paramKeys = Object.keys(req.params || {});
    if (paramKeys.length > maxParams) {
      res.status(400).json({ error: 'Too many path parameters or parameter too long' });
      return;
    }

    for (const key of paramKeys) {
      const val = req.params[key];
      if (val && val.length > maxLength) {
        res.status(400).json({ error: 'Too many path parameters or parameter too long' });
        return;
      }
    }

    // 2. Check raw URL path segments (fallback for when applied at router-level 
    // before req.params are fully parsed, ensuring early ReDoS protection)
    const segments = req.path.split('/');
    for (const segment of segments) {
      if (segment.length > maxLength) {
        res.status(400).json({ error: 'Too many path parameters or parameter too long' });
        return;
      }
    }

    next();
  };
}