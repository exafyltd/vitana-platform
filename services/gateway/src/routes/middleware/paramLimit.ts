import { Request, Response, NextFunction, RequestHandler } from 'express';

export function limitPathParams(maxParams = 5, maxLength = 200): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    // 1. Validate raw path early (e.g. when applied via router.use())
    // Uses RegExp only for basic segment extraction to safely bypass the vulnerable path-to-regexp matching
    if (req.path) {
      const segments = req.path.match(/[^/]+/g) || [];
      for (const segment of segments) {
        if (segment.length > maxLength) {
          return res.status(400).json({ 
            ok: false, 
            error: 'Too many path parameters or parameter too long' 
          });
        }
      }
    }

    // 2. Validate route params if already matched and populated by Express (e.g. route-specific middleware)
    if (req.params) {
      const keys = Object.keys(req.params);
      if (keys.length > maxParams) {
        return res.status(400).json({ 
          ok: false, 
          error: 'Too many path parameters or parameter too long' 
        });
      }

      for (const key of keys) {
        const val = req.params[key];
        if (typeof val === 'string' && val.length > maxLength) {
          return res.status(400).json({ 
            ok: false, 
            error: 'Too many path parameters or parameter too long' 
          });
        }
      }
    }

    next();
  };
}