import { Request, Response, NextFunction, RequestHandler } from 'express';

export function limitPathParams(maxParams = 5, maxLength = 200): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    // 1. Direct path-segment check to prevent ReDoS before route matching occurs.
    // When mounted in a router, req.path strips the mount path, so we count
    // the remaining segments. We use a generous threshold (maxParams + 2) to account
    // for literal segments like '/projects' inside the router path.
    const pathSegments = req.path.split('/').filter(Boolean);
    if (pathSegments.length > maxParams + 2) {
      return res.status(400).json({ ok: false, error: 'Too many path parameters' });
    }

    for (const segment of pathSegments) {
      if (segment.length > maxLength) {
        return res.status(400).json({ ok: false, error: 'Path parameter too long' });
      }
    }

    // 2. req.params check as specified in the plan (effective if applied as route-specific middleware)
    if (req.params) {
      const keys = Object.keys(req.params);
      if (keys.length > maxParams) {
        return res.status(400).json({ ok: false, error: 'Too many path parameters' });
      }

      for (const key of keys) {
        if (req.params[key] && req.params[key].length > maxLength) {
          return res.status(400).json({ ok: false, error: 'Path parameter too long' });
        }
      }
    }

    next();
  };
}