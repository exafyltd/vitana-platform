import { Request, Response, NextFunction, RequestHandler } from 'express';

/**
 * Middleware to mitigate ReDoS vulnerabilities in path-to-regexp.
 * Limits the number of path parameters and the length of each parameter.
 * 
 * @param maxParams Maximum allowed number of path parameters (default: 5)
 * @param maxLength Maximum allowed length for any single path parameter (default: 200)
 */
export function limitPathParams(maxParams: number = 5, maxLength: number = 200): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const keys = Object.keys(req.params || {});
    
    // Check maximum number of parameters
    if (keys.length > maxParams) {
      res.status(400).json({
        ok: false,
        error: 'Too many path parameters'
      });
      return;
    }

    // Check maximum length of each parameter value
    for (const key of keys) {
      const value = req.params[key];
      if (typeof value === 'string' && value.length > maxLength) {
        res.status(400).json({
          ok: false,
          error: 'Path parameter too long'
        });
        return;
      }
    }

    next();
  };
}