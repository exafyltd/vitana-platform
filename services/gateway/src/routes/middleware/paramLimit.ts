import { Request, Response, NextFunction, RequestHandler } from 'express';

/**
 * Middleware to mitigate Regular Expression Denial of Service (ReDoS)
 * vulnerability in path-to-regexp (< 0.1.13) by limiting the number 
 * and length of route parameters.
 *
 * @param maxParams Maximum number of path parameters allowed (default 5)
 * @param maxLength Maximum string length for any single parameter (default 200)
 */
export function limitPathParams(maxParams = 5, maxLength = 200): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.params) {
      next();
      return;
    }

    const keys = Object.keys(req.params);

    // Limit the number of parameters
    if (keys.length > maxParams) {
      res.status(400).json({ error: 'Too many path parameters or parameter too long' });
      return;
    }

    // Limit the length of each parameter value
    for (const key of keys) {
      const value = req.params[key];
      if (typeof value === 'string' && value.length > maxLength) {
        res.status(400).json({ error: 'Too many path parameters or parameter too long' });
        return;
      }
    }

    next();
  };
}