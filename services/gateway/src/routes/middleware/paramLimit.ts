import { Request, Response, NextFunction, RequestHandler } from 'express';

/**
 * Middleware to mitigate ReDoS vulnerabilities in path-to-regexp
 * by limiting the number of path parameters and their maximum lengths.
 */
export function limitPathParams(maxParams = 5, maxLength = 200): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.params) {
      next();
      return;
    }

    const keys = Object.keys(req.params);

    if (keys.length > maxParams) {
      res.status(400).json({
        ok: false,
        error: 'Too many path parameters or parameter too long'
      });
      return;
    }

    for (const key of keys) {
      const val = req.params[key];
      if (val && typeof val === 'string' && val.length > maxLength) {
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