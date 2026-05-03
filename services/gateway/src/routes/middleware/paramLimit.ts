import { Request, Response, NextFunction, RequestHandler } from 'express';

/**
 * Middleware to mitigate path-to-regexp ReDoS vulnerabilities by limiting
 * the number and length of path parameters in a request.
 * 
 * @param maxParams Maximum allowed number of path parameters (default: 5)
 * @param maxLength Maximum allowed string length per parameter (default: 200)
 */
export function limitPathParams(maxParams: number = 5, maxLength: number = 200): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    // req.params might be undefined if no parameters are matched yet, 
    // but typically express populates it as an empty object.
    const params = req.params || {};
    const keys = Object.keys(params);

    if (keys.length > maxParams) {
      res.status(400).json({ error: 'Too many path parameters' });
      return;
    }

    for (const key of keys) {
      const val = params[key];
      if (typeof val === 'string' && val.length > maxLength) {
        res.status(400).json({ error: 'Path parameter too long' });
        return;
      }
    }

    next();
  };
}