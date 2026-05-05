import { Request, Response, NextFunction, RequestHandler } from 'express';

/**
 * Middleware to mitigate ReDoS vulnerabilities in path-to-regexp.
 * Limits the total number of path parameters and the maximum length of any single parameter.
 */
export function limitPathParams(maxParams: number = 5, maxLength: number = 200): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.params) {
      next();
      return;
    }

    const keys = Object.keys(req.params);

    // Limit number of consecutive parameters
    if (keys.length > maxParams) {
      res.status(400).json({
        ok: false,
        error: 'Too many path parameters or parameter too long'
      });
      return;
    }

    // Limit length of individual parameters
    for (const key of keys) {
      const value = req.params[key];
      if (value && typeof value === 'string' && value.length > maxLength) {
        res.status(400).json({
          ok: false,
          error: 'Too many path parameters or parameter too long'
        });
        return;
      }
    }

    next();
  };
}