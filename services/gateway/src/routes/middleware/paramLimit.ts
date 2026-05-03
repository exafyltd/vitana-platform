import { Request, Response, NextFunction, RequestHandler } from 'express';

export function limitPathParams(maxParams = 5, maxLength = 200): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    // 1. Check matched route parameters (if applied directly to the route)
    const keys = Object.keys(req.params || {});
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

    // 2. Fallback: Check raw path segments (if applied via router.use globally)
    // Uses RegExp/split for validation to avoid vulnerable path-to-regexp parsing
    const pathSegments = req.path.split('/').filter(Boolean);
    
    if (pathSegments.length > maxParams + 5) {
      res.status(400).json({ error: 'Too many path parameters or parameter too long' });
      return;
    }
    
    for (const segment of pathSegments) {
      if (segment.length > maxLength) {
        res.status(400).json({ error: 'Too many path parameters or parameter too long' });
        return;
      }
    }
    
    next();
  };
}