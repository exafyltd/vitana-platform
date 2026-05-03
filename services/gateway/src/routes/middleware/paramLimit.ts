import { Request, Response, NextFunction, RequestHandler } from 'express';

export function limitPathParams(maxParams: number = 5, maxLength: number = 200): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const params = req.params || {};
    const keys = Object.keys(params);

    // 1. Check pre-parsed params (effective when middleware is mounted directly on routes)
    if (keys.length > maxParams) {
      res.status(400).json({ error: 'Too many path parameters or parameter too long' });
      return;
    }

    for (const key of keys) {
      if (params[key] && params[key].length > maxLength) {
        res.status(400).json({ error: 'Too many path parameters or parameter too long' });
        return;
      }
    }

    // 2. Validate raw path segments to provide robust pre-match protection against ReDoS.
    // Uses RegExp/split for validation to avoid the vulnerable path-to-regexp matching
    // when mounted globally via router.use().
    if (req.path) {
      const segments = req.path.split(/\//);
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