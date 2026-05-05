import { Request, Response, NextFunction, RequestHandler } from 'express';

export function limitPathParams(maxParams: number = 5, maxLength: number = 200): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    // 1. Check req.params if already populated (e.g. when applied at the route level)
    if (req.params) {
      const keys = Object.keys(req.params);
      if (keys.length > maxParams) {
        res.status(400).json({ ok: false, error: 'Too many path parameters or parameter too long' });
        return;
      }
      for (const key of keys) {
        const value = req.params[key];
        if (value && value.length > maxLength) {
          res.status(400).json({ ok: false, error: 'Too many path parameters or parameter too long' });
          return;
        }
      }
    }

    // 2. Pre-match check: parse the raw path to prevent ReDoS during route matching.
    // This allows the middleware to intercept attacks effectively when applied globally via router.use()
    const rawPath = req.path || '';
    const segments = rawPath.split('/').filter(Boolean);
    
    for (const segment of segments) {
      if (segment.length > maxLength) {
        res.status(400).json({ ok: false, error: 'Too many path parameters or parameter too long' });
        return;
      }
    }

    next();
  };
}