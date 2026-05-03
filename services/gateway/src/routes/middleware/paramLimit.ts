import { Request, Response, NextFunction, RequestHandler } from 'express';

/**
 * Middleware to mitigate ReDoS vulnerabilities in path-to-regexp by limiting
 * the number of route parameters and the maximum length of any single parameter.
 *
 * @param maxParams Maximum number of allowed path parameters (default 5)
 * @param maxLength Maximum length of any given path parameter value (default 200)
 */
export function limitPathParams(maxParams = 5, maxLength = 200): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const keys = Object.keys(req.params);
    
    if (keys.length > maxParams) {
      res.status(400).json({ error: 'Too many path parameters or parameter too long' });
      return;
    }
    
    for (const key of keys) {
      const paramValue = req.params[key];
      if (paramValue && paramValue.length > maxLength) {
        res.status(400).json({ error: 'Too many path parameters or parameter too long' });
        return;
      }
    }
    
    next();
  };
}