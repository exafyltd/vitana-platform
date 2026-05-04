import { Request, Response, NextFunction, RequestHandler } from 'express';

/**
 * Middleware to mitigate path-to-regexp ReDoS attacks by limiting 
 * the number of path parameters and their individual lengths.
 * 
 * @param maxParams - The maximum number of allowed path parameters (default: 5)
 * @param maxLength - The maximum allowed string length for any single parameter (default: 200)
 */
export function limitPathParams(maxParams = 5, maxLength = 200): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const keys = Object.keys(req.params);

    if (keys.length > maxParams) {
      res.status(400).json({ error: 'Too many path parameters or parameter too long' });
      return;
    }

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