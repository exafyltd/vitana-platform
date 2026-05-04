import { Request, Response, NextFunction, RequestHandler } from 'express';

/**
 * Middleware to mitigate ReDoS vulnerabilities in path-to-regexp parsing.
 * Limits the number of parsed parameters and the length of any path segment.
 */
export function limitPathParams(maxParams = 5, maxLength = 200): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    // 1. Validate raw URL segments
    // This provides global protection before Express matches the route with `path-to-regexp`.
    // It prevents ReDoS on global middleware mounts where req.params is not yet populated.
    const segments = req.path.split('/').filter(Boolean);
    for (const segment of segments) {
      if (segment.length > maxLength) {
        res.status(400).json({
          ok: false,
          error: 'Path parameter too long'
        });
        return;
      }
    }

    // 2. Validate explicitly mapped req.params
    // Provides strict constraint checking when mounted directly onto route definitions.
    const paramKeys = Object.keys(req.params || {});
    if (paramKeys.length > maxParams) {
      res.status(400).json({
        ok: false,
        error: 'Too many path parameters'
      });
      return;
    }

    for (const key of paramKeys) {
      const value = req.params[key];
      if (typeof value === 'string' && value.length > maxLength) {
        res.status(400).json({
          ok: false,
          error: 'Path parameter too long'
        });
        return;
      }
    }

    next();
  };
}