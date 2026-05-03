import { Request, Response, NextFunction, RequestHandler } from 'express';

export function limitPathParams(maxParams: number = 5, maxLength: number = 200): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    // 1. Validate populated req.params (effective when middleware runs after or during route match)
    if (req.params) {
      const keys = Object.keys(req.params);
      
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
    }

    // 2. Validate raw URL path segments (effective when middleware runs globally via router.use)
    // This blocks overly long path segments before `path-to-regexp` matches them, avoiding ReDoS.
    if (req.path) {
      const segments = req.path.split('/').filter(Boolean);
      for (const segment of segments) {
        if (segment.length > maxLength) {
          res.status(400).json({ error: 'Too many path parameters or parameter too long' });
          return;
        }
      }
    }

    next();
  };
}