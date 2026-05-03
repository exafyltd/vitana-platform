import { Request, Response, NextFunction, RequestHandler } from 'express';

/**
 * Middleware to mitigate ReDoS vulnerabilities in path-to-regexp by enforcing
 * strict limits on the number of path parameters and their maximum string length.
 * 
 * @param maxParams Maximum allowed number of path parameters (default: 5)
 * @param maxLength Maximum allowed length for any single path parameter (default: 200)
 */
export function limitPathParams(maxParams: number = 5, maxLength: number = 200): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const params = req.params || {};
    const keys = Object.keys(params);

    if (keys.length > maxParams) {
      res.status(400).json({ error: 'Too many path parameters or parameter too long' });
      return;
    }

    for (const key of keys) {
      const val = params[key];
      if (val && val.length > maxLength) {
        res.status(400).json({ error: 'Too many path parameters or parameter too long' });
        return;
      }
    }

    next();
  };
}