import { Request, Response, NextFunction, RequestHandler } from 'express';

export function limitPathParams(maxParams = 5, maxLength = 200): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    // 1. Strict limit on parsed req.params (effective when mounted directly on specific routes)
    if (req.params) {
      const keys = Object.keys(req.params);
      if (keys.length > maxParams) {
        res.status(400).json({ error: 'Too many path parameters or parameter too long' });
        return;
      }

      for (const key of keys) {
        const val = req.params[key];
        if (typeof val === 'string' && val.length > maxLength) {
          res.status(400).json({ error: 'Too many path parameters or parameter too long' });
          return;
        }
      }
    }

    // 2. Pre-emptive raw path validation (effective when mounted via router.use)
    // Helps mitigate ReDoS during routing by catching excessively long path segments
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