import { Request, Response, NextFunction, RequestHandler } from 'express';

export function limitPathParams(maxParams: number = 5, maxLength: number = 200): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    // 1. Safety fallback: Check raw path segments
    // This catches oversized segments before Express evaluates complex nested routes
    // and triggers ReDoS, especially useful when mounted as a router middleware.
    const pathStr = req.path || '';
    const pathSegments = pathStr.split('/');
    
    for (const segment of pathSegments) {
      if (segment.length > maxLength) {
        res.status(400).json({ error: 'Too many path parameters or parameter too long' });
        return;
      }
    }

    // 2. Exact match check: Parse req.params if already populated
    // This executes accurately when the middleware is applied directly on a route definition.
    if (req.params) {
      const keys = Object.keys(req.params);
      if (keys.length > maxParams) {
        res.status(400).json({ error: 'Too many path parameters or parameter too long' });
        return;
      }

      for (const key of keys) {
        if (req.params[key] && req.params[key].length > maxLength) {
          res.status(400).json({ error: 'Too many path parameters or parameter too long' });
          return;
        }
      }
    }

    next();
  };
}