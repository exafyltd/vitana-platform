import { Request, Response, NextFunction, RequestHandler } from 'express';

/**
 * Middleware to mitigate ReDoS vulnerabilities in older versions of path-to-regexp.
 * Limits the total number of path parameters and the maximum length of any single parameter.
 *
 * @param maxParams Maximum number of path parameters allowed (default 5)
 * @param maxLength Maximum string length for a single path parameter (default 200)
 */
export function limitPathParams(maxParams: number = 5, maxLength: number = 200): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const params = req.params || {};
    const keys = Object.keys(params);

    if (keys.length > maxParams) {
      return res.status(400).json({
        ok: false,
        error: 'Too many path parameters'
      });
    }

    for (const key of keys) {
      const value = params[key];
      if (value && value.length > maxLength) {
        return res.status(400).json({
          ok: false,
          error: 'Path parameter too long'
        });
      }
    }

    next();
  };
}