import { Request, Response, NextFunction, RequestHandler } from 'express';

export function limitPathParams(maxParams = 5, maxLength = 200): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    // 1. Defend against excessively long path segments before matching
    if (req.path) {
      // Uses RegExp only for validation, avoiding the vulnerable path-to-regexp matching
      const segmentsMatch = req.path.match(/[^\/]+/g);
      if (segmentsMatch) {
        for (const segment of segmentsMatch) {
          if (segment.length > maxLength) {
            res.status(400).json({ ok: false, error: 'Too many path parameters or parameter too long' });
            return;
          }
        }
      }
    }

    // 2. Defend against too many resolved parameters (if mounted on a specific route)
    const params = req.params || {};
    const keys = Object.keys(params);

    if (keys.length > maxParams) {
      res.status(400).json({ ok: false, error: 'Too many path parameters or parameter too long' });
      return;
    }

    for (const key of keys) {
      if (typeof params[key] === 'string' && params[key].length > maxLength) {
        res.status(400).json({ ok: false, error: 'Too many path parameters or parameter too long' });
        return;
      }
    }

    next();
  };
}