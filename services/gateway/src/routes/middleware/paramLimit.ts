import { Request, Response, NextFunction, RequestHandler } from 'express';

export function limitPathParams(maxParams = 5, maxLength = 200): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    // 1. Standard check: evaluate explicitly matched route parameters
    const keys = Object.keys(req.params || {});

    if (keys.length > maxParams) {
      return res.status(400).json({
        ok: false,
        error: 'Too many path parameters or parameter too long'
      });
    }

    for (const key of keys) {
      const val = req.params[key];
      if (val && typeof val === 'string' && val.length > maxLength) {
        return res.status(400).json({
          ok: false,
          error: 'Too many path parameters or parameter too long'
        });
      }
    }

    // 2. Global fallback: since Express defers req.params population until 
    // the specific route definition matches, we examine raw URL segments.
    // This mitigates CVE-2024-28176 before `path-to-regexp` executes deeply.
    const segments = req.path.split('/').filter(Boolean);
    for (const segment of segments) {
      if (segment.length > maxLength) {
        return res.status(400).json({
          ok: false,
          error: 'Too many path parameters or parameter too long'
        });
      }
    }

    next();
  };
}