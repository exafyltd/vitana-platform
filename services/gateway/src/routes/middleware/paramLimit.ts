import { Request, Response, NextFunction } from 'express';

export function limitPathParams(maxParams: number = 5, maxLength: number = 200) {
  return (req: Request, res: Response, next: NextFunction) => {
    // 1. Proactive check on raw path segments to prevent ReDoS during downstream route matching.
    // This executes early if mounted globally or at the router level.
    if (req.path) {
      const segments = req.path.split('/').filter(Boolean);
      for (const segment of segments) {
        if (segment.length > maxLength) {
          return res.status(400).json({ ok: false, error: 'Too many path parameters or parameter too long' });
        }
      }
      // Add a generous buffer for segment count to allow deep static paths, 
      // while preventing fundamentally excessive path inputs.
      if (segments.length > maxParams + 20) {
        return res.status(400).json({ ok: false, error: 'Too many path parameters or parameter too long' });
      }
    }

    // 2. Exact check on req.params as specified in the mitigation plan.
    // This executes effectively if the middleware is mounted directly on the vulnerable route.
    if (req.params) {
      const definedKeys = Object.keys(req.params).filter(k => req.params[k] !== undefined);
      if (definedKeys.length > maxParams) {
        return res.status(400).json({ ok: false, error: 'Too many path parameters or parameter too long' });
      }
      for (const key of definedKeys) {
        const val = req.params[key];
        if (val && val.length > maxLength) {
          return res.status(400).json({ ok: false, error: 'Too many path parameters or parameter too long' });
        }
      }
    }

    next();
  };
}