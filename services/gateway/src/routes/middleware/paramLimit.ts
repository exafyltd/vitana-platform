import { Request, Response, NextFunction, RequestHandler } from 'express';

/**
 * Middleware to mitigate ReDoS vulnerabilities in path-to-regexp by limiting
 * the number of path parameters and their maximum length.
 *
 * @param maxParams Maximum number of allowed path parameters (default: 5)
 * @param maxLength Maximum length of any single path parameter (default: 200)
 */
export function limitPathParams(maxParams = 5, maxLength = 200): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const params = req.params || {};
    const keys = Object.keys(params);

    if (keys.length > maxParams) {
      res.status(400).json({ ok: false, error: 'Too many path parameters' });
      return;
    }

    for (const key of keys) {
      const val = params[key];
      if (val && val.length > maxLength) {
        res.status(400).json({ ok: false, error: 'Path parameter too long' });
        return;
      }
    }

    next();
  };
}