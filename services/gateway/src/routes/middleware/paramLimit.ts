import { Request, Response, NextFunction, RequestHandler } from 'express';

export function limitPathParams(maxParams = 5, maxLength = 200): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    // 1. Pre-check the raw path to mitigate ReDoS before Express route parsing.
    // path-to-regexp operates on the raw path, so bounding the segments prevents deeply 
    // nested paths or overly long segments from reaching the vulnerable regex matcher.
    if (req.path) {
      const segments = req.path.split('/');
      
      if (segments.length > maxParams + 10) {
        res.status(400).json({ ok: false, error: 'Too many path parameters or parameter too long' });
        return;
      }

      for (const segment of segments) {
        if (segment.length > maxLength) {
          res.status(400).json({ ok: false, error: 'Too many path parameters or parameter too long' });
          return;
        }
      }
    }

    // 2. Explicitly validate req.params (post route-match validation)
    if (req.params) {
      const keys = Object.keys(req.params);
      
      if (keys.length > maxParams) {
        res.status(400).json({ ok: false, error: 'Too many path parameters or parameter too long' });
        return;
      }

      for (const key of keys) {
        const val = req.params[key];
        if (val && String(val).length > maxLength) {
          res.status(400).json({ ok: false, error: 'Too many path parameters or parameter too long' });
          return;
        }
      }
    }

    next();
  };
}