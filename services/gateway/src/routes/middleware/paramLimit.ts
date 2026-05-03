import { Request, Response, NextFunction, RequestHandler } from 'express';

/**
 * Middleware to limit the number and length of path parameters.
 * This mitigates ReDoS vulnerabilities in underlying routing libraries
 * (e.g., path-to-regexp) by preventing excessive backtracking.
 *
 * @param maxParams Maximum number of path parameters allowed.
 * @param maxLength Maximum string length for any single parameter.
 */
export function limitPathParams(maxParams: number = 5, maxLength: number = 200): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.params) {
      const keys = Object.keys(req.params);

      // Check parameter count
      if (keys.length > maxParams) {
        res.status(400).json({ error: 'Too many path parameters or parameter too long' });
        return;
      }

      // Check parameter lengths
      for (const key of keys) {
        const value = req.params[key];
        if (value && value.length > maxLength) {
          res.status(400).json({ error: 'Too many path parameters or parameter too long' });
          return;
        }
      }
    }

    next();
  };
}