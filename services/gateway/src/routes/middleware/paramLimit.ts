import { Request, Response, NextFunction, RequestHandler } from 'express';

/**
 * Middleware to mitigate ReDoS vulnerabilities in path-to-regexp by restricting 
 * the number and length of parsed route parameters.
 * 
 * @param maxParams Maximum allowed number of defined path parameters (default: 5)
 * @param maxLength Maximum allowed length for any single path parameter string (default: 200)
 */
export function limitPathParams(maxParams: number = 5, maxLength: number = 200): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const keys = Object.keys(req.params);
    let paramCount = 0;

    for (const key of keys) {
      const val = req.params[key];
      
      // Only count parameters that have actually been matched/populated
      if (val !== undefined) {
        paramCount++;
        
        if (typeof val === 'string' && val.length > maxLength) {
          res.status(400).json({ error: 'Path parameter too long' });
          return;
        }
      }
    }

    if (paramCount > maxParams) {
      res.status(400).json({ error: 'Too many path parameters' });
      return;
    }

    next();
  };
}