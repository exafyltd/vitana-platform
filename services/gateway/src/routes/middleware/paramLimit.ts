import { Request, Response, NextFunction, RequestHandler } from 'express';

export function limitPathParams(maxParams: number = 5, maxLength: number = 200): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    // 1. Prevent ReDoS before route matching by validating raw path segments.
    // This is effective when applied globally or at the router level.
    const segments = req.path.split('/').filter(Boolean);
    for (const segment of segments) {
      if (segment.length > maxLength) {
        res.status(400).json({ 
          ok: false, 
          error: 'Too many path parameters or parameter too long' 
        });
        return;
      }
    }
    
    // Fallback heuristic for an extraordinarily large number of raw path segments.
    // (We use maxParams + 20 to allow for static segments while bounding complexity)
    if (segments.length > maxParams + 20) {
      res.status(400).json({ 
        ok: false, 
        error: 'Too many path parameters or parameter too long' 
      });
      return;
    }

    // 2. Validate parsed parameters if route matching has already occurred.
    // This takes effect when applied as a route-level middleware.
    if (req.params) {
      const providedKeys = Object.keys(req.params).filter(k => req.params[k] !== undefined);
      if (providedKeys.length > maxParams) {
        res.status(400).json({ 
          ok: false, 
          error: 'Too many path parameters or parameter too long' 
        });
        return;
      }
      for (const key of providedKeys) {
        const val = req.params[key];
        if (typeof val === 'string' && val.length > maxLength) {
          res.status(400).json({ 
            ok: false, 
            error: 'Too many path parameters or parameter too long' 
          });
          return;
        }
      }
    }

    next();
  };
}