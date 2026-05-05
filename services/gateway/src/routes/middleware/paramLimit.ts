import { Request, Response, NextFunction, RequestHandler } from 'express';

/**
 * Middleware to mitigate `path-to-regexp` ReDoS vulnerabilities by limiting
 * the number of route parameters and their maximum lengths.
 */
export function limitPathParams(maxParams: number = 5, maxLength: number = 200): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.params) {
      next();
      return;
    }

    const keys = Object.keys(req.params);
    
    // Check total parameter count
    if (keys.length > maxParams) {
      res.status(400).json({ 
        ok: false, 
        error: 'Too many path parameters' 
      });
      return;
    }

    // Check individual parameter lengths
    for (const key of keys) {
      const value = req.params[key];
      if (value && value.length > maxLength) {
        res.status(400).json({ 
          ok: false, 
          error: `Path parameter too long: ${key}` 
        });
        return;
      }
    }

    next();
  };
}