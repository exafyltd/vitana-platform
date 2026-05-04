import { Request, Response, NextFunction, RequestHandler } from 'express';

/**
 * Middleware to limit the number and length of path parameters.
 * Mitigates Regular Expression Denial of Service (ReDoS) vulnerabilities
 * in the underlying path-to-regexp Express routing dependency.
 *
 * @param maxParams Maximum allowed number of path parameters (default: 5)
 * @param maxLength Maximum allowed length for any single path parameter (default: 200)
 */
export function limitPathParams(maxParams: number = 5, maxLength: number = 200): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.params) {
      next();
      return;
    }

    const keys = Object.keys(req.params);
    
    if (keys.length > maxParams) {
      res.status(400).json({ error: 'Too many path parameters' });
      return;
    }

    for (const key of keys) {
      const val = req.params[key];
      if (val && val.length > maxLength) {
        res.status(400).json({ error: 'Path parameter too long' });
        return;
      }
    }

    next();
  };
}