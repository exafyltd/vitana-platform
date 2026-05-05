import { Request, Response, NextFunction, RequestHandler } from 'express';

export function limitPathParams(maxParams: number = 5, maxLength: number = 200): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    // 1. Validate strictly matched req.params when placed directly on a specific route
    const params = req.params || {};
    const keys = Object.keys(params);

    if (keys.length > maxParams) {
      res.status(400).json({ ok: false, error: 'Too many path parameters or parameter too long' });
      return;
    }

    for (const key of keys) {
      if (params[key] && params[key].length > maxLength) {
        res.status(400).json({ ok: false, error: 'Too many path parameters or parameter too long' });
        return;
      }
    }

    // 2. Validate raw path length and segments to protect against generic router.use() placements
    // Uses RegExp / split only for validation, strictly avoiding the vulnerable path-to-regexp mechanism
    const cleanPath = req.path.replace(/^\/|\/$/g, '');
    const pathSegments = cleanPath ? cleanPath.split('/') : [];
    
    // We allow standard paths plus the max param limit
    if (pathSegments.length > maxParams + 10) { 
      res.status(400).json({ ok: false, error: 'Too many path parameters or parameter too long' });
      return;
    }

    for (const segment of pathSegments) {
      if (segment.length > maxLength) {
        res.status(400).json({ ok: false, error: 'Too many path parameters or parameter too long' });
        return;
      }
    }

    next();
  };
}