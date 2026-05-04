import { Request, Response, NextFunction, RequestHandler } from 'express';

/**
 * Middleware to mitigate ReDoS CVE in path-to-regexp by limiting the
 * number of path parameters and their maximum length before route matching.
 */
export function limitPathParams(maxParams = 5, maxLength = 200): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const params = req.params || {};
    const keys = Object.keys(params);

    if (keys.length > maxParams) {
      res.status(400).json({
        ok: false,
        error: 'Too many path parameters'
      });
      return;
    }

    for (const key of keys) {
      const value = params[key];
      if (value && value.length > maxLength) {
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