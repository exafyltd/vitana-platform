import { Request, Response, NextFunction, RequestHandler } from 'express';

export function limitPathParams(maxParams = 5, maxLength = 200): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    // 1. Strict param limits based on Express's req.params parsing
    if (req.params) {
      const keys = Object.keys(req.params);
      if (keys.length > maxParams) {
        return res.status(400).json({ ok: false, error: 'Too many path parameters or parameter too long' });
      }

      for (const key of keys) {
        const value = req.params[key];
        if (value && typeof value === 'string' && value.length > maxLength) {
          return res.status(400).json({ ok: false, error: 'Too many path parameters or parameter too long' });
        }
      }
    }

    // 2. Pre-check raw path segments to catch long strings before express match (avoiding path-to-regexp entirely)
    if (req.path) {
      const segments = req.path.split('/');
      for (const segment of segments) {
        if (segment.length > maxLength) {
          return res.status(400).json({ ok: false, error: 'Too many path parameters or parameter too long' });
        }
      }
    }

    next();
  };
}