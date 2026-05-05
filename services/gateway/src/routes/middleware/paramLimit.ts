import { Request, Response, NextFunction } from 'express';

export function limitPathParams(maxParams = 5, maxLength = 200) {
  return (req: Request, res: Response, next: NextFunction) => {
    // 1. Check raw path segments first.
    // This allows the middleware to block extremely long segments even before 
    // Express evaluates the route via path-to-regexp if mounted globally.
    if (req.path) {
      const segments = req.path.split('/');
      for (const segment of segments) {
        if (segment.length > maxLength) {
          return res.status(400).json({
            ok: false,
            error: 'Too many path parameters or parameter too long',
          });
        }
      }
    }

    // 2. Check parsed route parameters.
    // Limits the total count and length of extracted path parameters.
    if (req.params) {
      const keys = Object.keys(req.params);
      if (keys.length > maxParams) {
        return res.status(400).json({
          ok: false,
          error: 'Too many path parameters or parameter too long',
        });
      }

      for (const key of keys) {
        const value = req.params[key];
        if (value && value.length > maxLength) {
          return res.status(400).json({
            ok: false,
            error: 'Too many path parameters or parameter too long',
          });
        }
      }
    }

    next();
  };
}