import { Request, Response, NextFunction } from 'express';

/**
 * Middleware to limit the number and length of Express route path parameters.
 * This is a mitigation for ReDoS vulnerabilities in path-to-regexp matching.
 * 
 * @param maxParams Maximum number of path parameters allowed (default 5)
 * @param maxLength Maximum string length for any single path parameter (default 200)
 */
export function limitPathParams(maxParams: number = 5, maxLength: number = 200) {
  return (req: Request, res: Response, next: NextFunction) => {
    const paramKeys = Object.keys(req.params || {});

    // Check 1: Limit the number of parameters
    if (paramKeys.length > maxParams) {
      return res.status(400).json({
        ok: false,
        error: 'Too many path parameters or parameter too long'
      });
    }

    // Check 2: Limit the length of each parameter
    for (const key of paramKeys) {
      const value = req.params[key];
      if (typeof value === 'string' && value.length > maxLength) {
        return res.status(400).json({
          ok: false,
          error: 'Too many path parameters or parameter too long'
        });
      }
    }

    next();
  };
}