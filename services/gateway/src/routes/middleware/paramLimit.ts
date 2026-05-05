import { Request, Response, NextFunction, RequestHandler } from 'express';

export function limitPathParams(maxParams: number = 5, maxLength: number = 200): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    // 1. Prevent ReDoS at the global/router level before route matching populates req.params.
    // We split the raw path to inspect individual raw segments for excessive length.
    const segments = req.path.split('/').filter(Boolean);

    for (const segment of segments) {
      if (segment.length > maxLength) {
        res.status(400).json({ ok: false, error: 'Too many path parameters or parameter too long' });
        return;
      }
    }

    // 2. Validate req.params if the middleware is applied at the route level
    // where Express has already parsed and populated the parameters.
    if (req.params) {
      const keys = Object.keys(req.params);
      
      if (keys.length > maxParams) {
        res.status(400).json({ ok: false, error: 'Too many path parameters or parameter too long' });
        return;
      }

      for (const key of keys) {
        const val = req.params[key];
        if (val && val.length > maxLength) {
          res.status(400).json({ ok: false, error: 'Too many path parameters or parameter too long' });
          return;
        }
      }
    }

    next();
  };
}