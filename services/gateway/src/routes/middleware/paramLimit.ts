import { Request, Response, NextFunction, RequestHandler } from 'express';

export function limitPathParams(maxParams = 5, maxLength = 200): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    // 1. Raw segment check: Prevents ReDoS prior to `path-to-regexp` execution
    // when applied globally or at the router level via `app.use` / `router.use`.
    const segments = req.path.split('/').filter(Boolean);
    for (const segment of segments) {
      if (segment.length > maxLength) {
        res.status(400).json({ 
          ok: false, 
          error: 'Too many path parameters or parameter too long' 
        });
        return;
      }
    }

    // 2. Plan specification: Validate parsed req.params if populated (e.g. applied on specific route)
    const params = req.params || {};
    const keys = Object.keys(params);

    if (keys.length > maxParams) {
      res.status(400).json({ 
        ok: false, 
        error: 'Too many path parameters or parameter too long' 
      });
      return;
    }

    for (const key of keys) {
      const val = params[key];
      if (typeof val === 'string' && val.length > maxLength) {
        res.status(400).json({ 
          ok: false, 
          error: 'Too many path parameters or parameter too long' 
        });
        return;
      }
    }

    next();
  };
}