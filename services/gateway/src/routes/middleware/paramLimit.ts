import { Request, Response, NextFunction, RequestHandler } from 'express';

/**
 * Middleware to mitigate ReDoS vulnerabilities in path-to-regexp by enforcing limits
 * on the number and length of path parameters.
 * 
 * @param maxParams Maximum number of allowed path parameters.
 * @param maxLength Maximum allowed string length for any single path parameter.
 */
export function limitPathParams(maxParams: number = 5, maxLength: number = 200): RequestHandler {
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
      if (value && typeof value === 'string' && value.length > maxLength) {
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