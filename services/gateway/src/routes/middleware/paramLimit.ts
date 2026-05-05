import { Request, Response, NextFunction, RequestHandler } from 'express';

export function limitPathParams(maxParams = 5, maxLength = 200): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    // 1. Fast regex checks on the raw path to prevent ReDoS during downstream express routing.
    // Uses RegExp only for validation, avoiding the vulnerable path-to-regexp matching.
    const longSegmentRegex = new RegExp(`/[^/]{${maxLength + 1},}`);
    if (longSegmentRegex.test(req.path)) {
      res.status(400).json({ ok: false, error: 'Too many path parameters or parameter too long' });
      return;
    }

    // Reject requests with excessively many segments (maxParams + allowance for static route parts)
    const excessiveSegmentsRegex = new RegExp(`(?:/[^/]+){${maxParams + 10},}`);
    if (excessiveSegmentsRegex.test(req.path)) {
      res.status(400).json({ ok: false, error: 'Too many path parameters or parameter too long' });
      return;
    }

    // 2. Exact check on req.params (effective if middleware is mounted directly on a route)
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

    next();
  };
}