import { Request, Response, NextFunction, RequestHandler } from 'express';

/**
 * Middleware to mitigate ReDoS vulnerabilities in express's path-to-regexp router.
 * Limits the number of path parameters and their maximum string length.
 */
export function limitPathParams(maxParams: number = 5, maxLength: number = 200): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    // 1. Pre-routing defense: evaluate raw path segments.
    // This catches excessively long segments before Express route matching occurs,
    // which is vital for preventing backtracking loops when mounted globally via router.use()
    const path = req.path || '';
    const urlSegments = path.split('/');
    
    for (const segment of urlSegments) {
      if (segment.length > maxLength) {
        res.status(400).json({ error: 'Too many path parameters or parameter too long' });
        return;
      }
    }

    // 2. Post-routing defense: evaluate parsed req.params.
    // This evaluates against parameter counts directly as defined by the route,
    // when the middleware is mounted inline on specific routes.
    const params = req.params || {};
    const keys = Object.keys(params);

    if (keys.length > maxParams) {
      res.status(400).json({ error: 'Too many path parameters or parameter too long' });
      return;
    }

    for (const key of keys) {
      const value = params[key];
      if (value && String(value).length > maxLength) {
        res.status(400).json({ error: 'Too many path parameters or parameter too long' });
        return;
      }
    }

    next();
  };
}