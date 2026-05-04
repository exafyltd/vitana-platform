import { Request, Response, NextFunction, RequestHandler } from 'express';

/**
 * Middleware to mitigate ReDoS vulnerabilities in path-to-regexp.
 * Limits the total number of route parameters and their lengths
 * to prevent catastrophic backtracking during route matching.
 */
export function limitPathParams(maxParams = 5, maxLength = 200): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const params = req.params || {};
    const paramKeys = Object.keys(params);

    // Enforce parameter count limit
    if (paramKeys.length > maxParams) {
      res.status(400).json({ error: 'Too many path parameters or parameter too long' });
      return;
    }

    // Enforce individual parameter length limit
    for (const key of paramKeys) {
      const value = params[key];
      if (value && value.length > maxLength) {
        res.status(400).json({ error: 'Too many path parameters or parameter too long' });
        return;
      }
    }

    next();
  };
}