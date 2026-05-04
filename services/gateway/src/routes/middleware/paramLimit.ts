import { Request, Response, NextFunction, RequestHandler } from 'express';

export function limitPathParams(maxParams: number = 5, maxLength: number = 200): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    // 1. Check req.params (effective when mounted directly on route handlers)
    const keys = Object.keys(req.params || {});
    if (keys.length > maxParams) {
      res.status(400).json({ ok: false, error: 'Too many path parameters or parameter too long' });
      return;
    }

    for (const key of keys) {
      const val = req.params[key];
      if (typeof val === 'string' && val.length > maxLength) {
        res.status(400).json({ ok: false, error: 'Too many path parameters or parameter too long' });
        return;
      }
    }

    // 2. Fallback defensive check on raw path segments (effective when mounted globally or via router.use)
    // We use a simple native RegExp to split segments, avoiding vulnerable path-to-regexp matching.
    const segments = req.path.split(/\/+/);
    for (const segment of segments) {
      if (segment.length > maxLength) {
        res.status(400).json({ ok: false, error: 'Too many path parameters or parameter too long' });
        return;
      }
    }

    next();
  };
}