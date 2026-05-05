import { Request, Response, NextFunction, RequestHandler } from 'express';

export function limitPathParams(maxParams: number = 5, maxLength: number = 200): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    // 1. Raw path segment check (Protects against ReDoS before path-to-regexp evaluates it,
    // which is necessary when mounted globally via router.use())
    if (req.path) {
      const segments = req.path.split('/');
      // Generous upper bound for raw segments, since we don't know which are static vs dynamic
      if (segments.length > maxParams + 20) {
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

    // 2. Specific req.params check (Satisfies plan requirements, functions accurately when 
    // mounted directly on specific routes where req.params are fully populated)
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