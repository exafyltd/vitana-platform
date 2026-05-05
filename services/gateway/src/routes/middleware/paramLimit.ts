import { Request, Response, NextFunction, RequestHandler } from 'express';

export function limitPathParams(maxParams: number = 5, maxLength: number = 200): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    // Validate raw path segments to avoid vulnerable path-to-regexp matching
    if (req.path) {
      const segments = req.path.match(/[^/]+/g) || [];
      for (const segment of segments) {
        if (segment.length > maxLength) {
          res.status(400).json({ ok: false, error: 'Path parameter too long' });
          return;
        }
      }
    }

    // Strictly validate parsed req.params
    const params = req.params || {};
    const keys = Object.keys(params);

    if (keys.length > maxParams) {
      res.status(400).json({ ok: false, error: 'Too many path parameters' });
      return;
    }

    for (const key of keys) {
      if (params[key] && params[key].length > maxLength) {
        res.status(400).json({ ok: false, error: 'Path parameter too long' });
        return;
      }
    }

    next();
  };
}