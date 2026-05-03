import { Request, Response, NextFunction } from 'express';

/**
 * Middleware to mitigate ReDoS vulnerability in path-to-regexp.
 * Limits the number of path parameters and the length of each parameter.
 * 
 * @param maxParams Maximum number of path parameters allowed (default: 5)
 * @param maxLength Maximum length of any single path parameter (default: 200)
 */
export function limitPathParams(maxParams = 5, maxLength = 200) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.params) {
      return next();
    }

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