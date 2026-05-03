import { Request, Response, NextFunction, RequestHandler } from 'express';

export function limitPathParams(maxParams = 5, maxLength = 200): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    // 1. Raw Path Validation (RegExp)
    // Uses RegExp only for validation of the raw path. This avoids the vulnerable 
    // path-to-regexp matching if the middleware is mounted via router.use() globally.
    const path = req.path || '';
    
    // RegExp to check for any segment exceeding maxLength
    const longSegmentRegex = new RegExp(`[^/]{${maxLength + 1},}`);
    if (longSegmentRegex.test(path)) {
      res.status(400).json({ error: 'Too many path parameters or parameter too long' });
      return;
    }

    // Proxy count for deeply nested routes to avoid exponential backtracking
    const segments = path.split('/').filter(Boolean);
    if (segments.length > maxParams + 5) {
      res.status(400).json({ error: 'Too many path parameters or parameter too long' });
      return;
    }

    // 2. Specific Parameter Validation (req.params)
    // Evaluates parsed parameters if the middleware is mounted directly on a route.
    const params = req.params || {};
    const keys = Object.keys(params);
    
    if (keys.length > maxParams) {
      res.status(400).json({ error: 'Too many path parameters or parameter too long' });
      return;
    }

    for (const key of keys) {
      const value = params[key];
      if (value && value.length > maxLength) {
        res.status(400).json({ error: 'Too many path parameters or parameter too long' });
        return;
      }
    }

    next();
  };
}