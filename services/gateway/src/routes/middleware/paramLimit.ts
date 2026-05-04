import { Request, Response, NextFunction, RequestHandler } from 'express';

export function limitPathParams(maxParams: number = 5, maxLength: number = 200): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    // 1. Fast-path raw validation using RegExp to avoid vulnerable path-to-regexp matching.
    // This executes before/during routing and stops excessively long segments 
    // from triggering catastrophic backtracking in Express's route matchers.
    const hasLongSegments = new RegExp(`[^/]{${maxLength + 1},}`).test(req.path);
    if (hasLongSegments) {
      res.status(400).json({ ok: false, error: 'Too many path parameters or parameter too long' });
      return;
    }

    // 2. Parse req.params and count its keys as prescribed.
    // This is effective when the middleware is applied at the route-level.
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