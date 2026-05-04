import { Request, Response, NextFunction, RequestHandler } from 'express';

export function limitPathParams(maxParams: number = 5, maxLength: number = 200): RequestHandler {
  // Uses RegExp only for validation, avoiding the vulnerable path-to-regexp matching.
  const longSegmentRegex = new RegExp(`[^/]{${maxLength + 1},}`);

  return (req: Request, res: Response, next: NextFunction): void => {
    // 1. Validate raw path length to prevent ReDoS before route matching
    if (longSegmentRegex.test(req.path)) {
      res.status(400).json({ error: 'Too many path parameters or parameter too long' });
      return;
    }

    // Prevent excessive segments which cause backtracking
    // We count segments in the path as a proxy for maxParams when req.params isn't populated yet.
    // Adding 10 as a safe buffer for static route prefixes (e.g. /api/v1/users/...)
    const pathSegments = req.path.split('/').filter(Boolean);
    if (pathSegments.length > maxParams + 10) {
      res.status(400).json({ error: 'Too many path parameters or parameter too long' });
      return;
    }

    // 2. Parse req.params and count its keys as per the core plan
    if (req.params) {
      const keys = Object.keys(req.params);
      if (keys.length > maxParams) {
        res.status(400).json({ error: 'Too many path parameters or parameter too long' });
        return;
      }
      for (const key of keys) {
        const value = req.params[key];
        if (value && value.length > maxLength) {
          res.status(400).json({ error: 'Too many path parameters or parameter too long' });
          return;
        }
      }
    }

    next();
  };
}