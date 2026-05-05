import { Request, Response, NextFunction, RequestHandler } from 'express';

export function limitPathParams(maxParams: number = 5, maxLength: number = 200): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    // 1. Validate the raw URL path to prevent catastrophic backtracking 
    // during Express's `path-to-regexp` route match phase.
    const pathSegments = req.path.split('/').filter(Boolean);
    for (const segment of pathSegments) {
      if (segment.length > maxLength) {
        res.status(400).json({ 
          ok: false, 
          error: 'Path parameter too long' 
        });
        return;
      }
    }

    // 2. Validate parsed req.params as defined by the security plan constraints.
    const params = req.params || {};
    const keys = Object.keys(params);

    if (keys.length > maxParams) {
      res.status(400).json({ ok: false, error: 'Too many path parameters' });
      return;
    }

    for (const key of keys) {
      const value = params[key];
      if (typeof value === 'string' && value.length > maxLength) {
        res.status(400).json({ ok: false, error: 'Path parameter too long' });
        return;
      }
    }

    next();
  };
}