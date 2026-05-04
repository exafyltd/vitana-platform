import { Request, Response, NextFunction, RequestHandler } from 'express';

export function limitPathParams(maxParams: number = 5, maxLength: number = 200): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    // 1. Validate raw path length to prevent ReDoS before route matching occurs.
    // Uses RegExp for validation, avoiding vulnerable path-to-regexp backtracking.
    const segmentRegex = new RegExp(`[^/]{${maxLength + 1},}`);
    if (segmentRegex.test(req.path)) {
      res.status(400).json({ error: 'Too many path parameters or parameter too long' });
      return;
    }

    // 2. Parse req.params and count keys (effective when applied to specific routes)
    const paramKeys = Object.keys(req.params || {});
    if (paramKeys.length > maxParams) {
      res.status(400).json({ error: 'Too many path parameters or parameter too long' });
      return;
    }

    for (const key of paramKeys) {
      if (req.params[key] && req.params[key].length > maxLength) {
        res.status(400).json({ error: 'Too many path parameters or parameter too long' });
        return;
      }
    }

    next();
  };
}