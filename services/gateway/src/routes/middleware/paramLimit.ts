import { Request, Response, NextFunction, RequestHandler } from 'express';

export function limitPathParams(maxParams: number = 5, maxLength: number = 200): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    // 1. Validate populated req.params (effective when route has already matched)
    if (req.params) {
      const paramKeys = Object.keys(req.params);
      if (paramKeys.length > maxParams) {
        res.status(400).json({ error: 'Too many path parameters or parameter too long' });
        return;
      }

      for (const key of paramKeys) {
        const val = req.params[key];
        if (val && val.length > maxLength) {
          res.status(400).json({ error: 'Too many path parameters or parameter too long' });
          return;
        }
      }
    }

    // 2. Pre-validate req.path to protect against catastrophic backtracking 
    // before route matching occurs (effective when mounted via router.use)
    const maxSegments = maxParams + 10; // Allow arbitrary safe buffer for static path segments
    const pathSegments = (req.path || '').split('/').filter(Boolean);
    
    if (pathSegments.length > maxSegments) {
      res.status(400).json({ error: 'Too many path parameters or parameter too long' });
      return;
    }

    for (const segment of pathSegments) {
      if (segment.length > maxLength) {
        res.status(400).json({ error: 'Too many path parameters or parameter too long' });
        return;
      }
    }

    // 3. Safe RegExp check as an additional validation layer (avoids vulnerable path-to-regexp)
    const safeRegex = new RegExp(`^(\\/[^\\/]{0,${maxLength}}){0,${maxSegments}}\\/?$`);
    if (!safeRegex.test(req.path || '')) {
      res.status(400).json({ error: 'Too many path parameters or parameter too long' });
      return;
    }

    next();
  };
}