import { Request, Response, NextFunction, RequestHandler } from 'express';

/**
 * Middleware to mitigate ReDoS vulnerabilities in path-to-regexp by limiting
 * the number of path parameters and the maximum length of each parameter.
 *
 * @param maxParams Maximum number of path parameters allowed (default: 5)
 * @param maxLength Maximum string length for each parameter (default: 200)
 */
export function limitPathParams(maxParams = 5, maxLength = 200): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    if (req.params) {
      const keys = Object.keys(req.params);
      
      if (keys.length > maxParams) {
        res.status(400).json({ error: 'Too many path parameters or parameter too long' });
        return;
      }

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