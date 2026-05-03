import { Request, Response, NextFunction, RequestHandler } from 'express';

export function limitPathParams(maxParams = 5, maxLength = 200): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    // 1. Check req.params if already populated (e.g., when mounted as route-level middleware)
    const keys = Object.keys(req.params || {});
    
    if (keys.length > maxParams) {
      res.status(400).json({ error: 'Too many path parameters or parameter too long' });
      return;
    }

    for (const key of keys) {
      const value = req.params[key];
      if (typeof value === 'string' && value.length > maxLength) {
        res.status(400).json({ error: 'Too many path parameters or parameter too long' });
        return;
      }
    }

    // 2. Pre-route validation of raw URL segments to prevent ReDoS in path-to-regexp
    // Uses standard RegExp for safe validation before Express routing occurs.
    const pathSegments = (req.path || '').match(/[^/]+/g) || [];
    for (const segment of pathSegments) {
      if (segment.length > maxLength) {
        res.status(400).json({ error: 'Too many path parameters or parameter too long' });
        return;
      }
    }

    next();
  };
}