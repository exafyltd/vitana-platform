import { Request, Response, NextFunction, RequestHandler } from 'express';

export function limitPathParams(maxParams = 5, maxLength = 200): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    // 1. Raw path validation using RegExp and segment counts to prevent ReDoS before route matching.
    if (req.path) {
      // Use RegExp to detect any overly long segment, avoiding path-to-regexp parsing.
      const tooLongRegex = new RegExp(`/[^/]{${maxLength + 1},}(?:/|$)`);
      if (tooLongRegex.test(req.path)) {
        res.status(400).json({ ok: false, error: 'Path parameter too long' });
        return;
      }

      // Fallback: check total path segments. We add a buffer of 5 to maxParams 
      // to account for static path segments in the route (e.g. /api/v1/users/:id/...).
      const segments = req.path.split('/').filter(Boolean);
      if (segments.length > maxParams + 5) {
        res.status(400).json({ ok: false, error: 'Too many path parameters' });
        return;
      }
    }

    // 2. req.params validation.
    // This specifically limits the number of parsed parameters when applied at the route level.
    if (req.params) {
      const keys = Object.keys(req.params);
      if (keys.length > maxParams) {
        res.status(400).json({ ok: false, error: 'Too many path parameters' });
        return;
      }

      for (const key of keys) {
        if (req.params[key] && req.params[key].length > maxLength) {
          res.status(400).json({ ok: false, error: 'Path parameter too long' });
          return;
        }
      }
    }

    next();
  };
}