import { Request, Response, NextFunction, RequestHandler } from 'express';

export function limitPathParams(maxParams: number = 5, maxLength: number = 200): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    // 1. Validate parsed path parameters (applicable if middleware is mounted directly on a route)
    const keys = Object.keys(req.params || {});
    if (keys.length > maxParams) {
      res.status(400).json({ ok: false, error: 'Too many path parameters or parameter too long' });
      return;
    }

    for (const key of keys) {
      const value = req.params[key];
      if (typeof value === 'string' && value.length > maxLength) {
        res.status(400).json({ ok: false, error: 'Too many path parameters or parameter too long' });
        return;
      }
    }

    // 2. Validate raw path segments (crucial when applied via router.use() prior to route matching)
    // This prevents Express from executing the vulnerable path-to-regexp logic on malicious nested paths.
    if (req.path) {
      const segments = req.path.split('/').filter(Boolean);
      
      // We check segments against maxParams plus a generous buffer for static path parts
      // (e.g., '/api/v1/users/:id/projects/:projectId' has static segments mixed with params).
      if (segments.length > maxParams + 5) {
        res.status(400).json({ ok: false, error: 'Too many path parameters or parameter too long' });
        return;
      }

      for (const segment of segments) {
        if (segment.length > maxLength) {
          res.status(400).json({ ok: false, error: 'Too many path parameters or parameter too long' });
          return;
        }
      }
    }

    next();
  };
}