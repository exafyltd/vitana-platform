import { Request, Response, NextFunction, RequestHandler } from 'express';

export function limitPathParams(maxParams: number = 5, maxLength: number = 200): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    // 1. Inspect parsed req.params (applicable if mounted on specific routes)
    const keys = Object.keys(req.params || {});
    if (keys.length > maxParams) {
      res.status(400).json({ error: 'Too many path parameters or parameter too long' });
      return;
    }

    for (const key of keys) {
      const val = req.params[key];
      if (val && typeof val === 'string' && val.length > maxLength) {
        res.status(400).json({ error: 'Too many path parameters or parameter too long' });
        return;
      }
    }

    // 2. Inspect raw req.path to protect against ReDoS before route matching completes.
    // When middleware is applied via router.use(), req.params may not be fully populated yet.
    // By validating the raw path segments, we avoid the path-to-regexp vulnerability completely.
    const segments = (req.path || '').split('/').filter(Boolean);
    
    // Validate length of each segment in the path
    for (const segment of segments) {
      if (segment.length > maxLength) {
        res.status(400).json({ error: 'Too many path parameters or parameter too long' });
        return;
      }
    }

    // A generous limit for the total number of segments to prevent exponential backtracking
    // It assumes a route won't legitimately have more than maxParams + 10 segments total
    if (segments.length > maxParams + 10) {
      res.status(400).json({ error: 'Too many path parameters or parameter too long' });
      return;
    }

    next();
  };
}