import { Request, Response, NextFunction, RequestHandler } from 'express';

/**
 * Middleware to mitigate path-to-regexp ReDoS vulnerabilities by limiting
 * the number of path parameters and their maximum lengths.
 */
export function limitPathParams(maxParams = 5, maxLength = 200): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const keys = Object.keys(req.params);
    
    if (keys.length > maxParams) {
      res.status(400).json({ error: 'Too many path parameters' });
      return;
    }

    for (const key of keys) {
      if (req.params[key] && req.params[key].length > maxLength) {
        res.status(400).json({ error: 'Path parameter too long' });
        return;
      }
    }

    next();
  };
}