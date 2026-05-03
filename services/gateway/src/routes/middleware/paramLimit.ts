import { Request, Response, NextFunction, RequestHandler } from 'express';

export function limitPathParams(maxParams: number = 5, maxLength: number = 200): RequestHandler {
  // Uses RegExp only for validation, avoiding the vulnerable path-to-regexp matching.
  const lengthValidRegex = new RegExp(`^.{0,${maxLength}}$`);

  return (req: Request, res: Response, next: NextFunction): void => {
    // 1. Check req.params if they are populated (e.g., when mounted directly on a route)
    if (req.params) {
      const keys = Object.keys(req.params);
      if (keys.length > maxParams) {
        res.status(400).json({ error: 'Too many path parameters or parameter too long' });
        return;
      }

      for (const key of keys) {
        const val = req.params[key];
        if (val && !lengthValidRegex.test(String(val))) {
          res.status(400).json({ error: 'Too many path parameters or parameter too long' });
          return;
        }
      }
    }

    // 2. Fallback: pre-validate raw URL segments to prevent ReDoS before express route parsing
    // This protects against CPU exhaustion when the middleware is mounted early via router.use()
    if (req.path) {
      const segments = req.path.split('/').filter(Boolean);
      for (const segment of segments) {
        // Enforce maxLength on raw segments
        if (!lengthValidRegex.test(segment)) {
          res.status(400).json({ error: 'Too many path parameters or parameter too long' });
          return;
        }
      }
    }

    next();
  };
}