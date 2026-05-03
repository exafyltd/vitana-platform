import { Request, Response, NextFunction, RequestHandler } from 'express';

/**
 * Middleware to mitigate ReDoS vulnerabilities in older versions of `path-to-regexp`.
 * Limits the number of path parameters and the maximum length of any single parameter.
 *
 * @param maxParams Maximum number of path parameters allowed (default: 5)
 * @param maxLength Maximum length of any single path parameter (default: 200)
 */
export function limitPathParams(maxParams = 5, maxLength = 200): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const paramKeys = Object.keys(req.params || {});
    
    // Check maximum number of parameters
    if (paramKeys.length > maxParams) {
      res.status(400).json({ error: 'Too many path parameters' });
      return;
    }

    // Check maximum length of each parameter
    for (const key of paramKeys) {
      const val = req.params[key];
      if (val && val.length > maxLength) {
        res.status(400).json({ error: 'Path parameter too long' });
        return;
      }
    }

    next();
  };
}