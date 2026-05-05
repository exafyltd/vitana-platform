import { Request, Response, NextFunction, RequestHandler } from 'express';

export function limitPathParams(maxParams: number = 5, maxLength: number = 200): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    // Express populates req.params after route matching.
    // Since this middleware is applied via router.use() to stop ReDoS *before* matching occurs,
    // we also inspect the raw path segments directly.
    const pathSegments = req.path.split('/').filter(Boolean);

    // Provide a generous buffer for static path segments in the raw URL check
    if (pathSegments.length > maxParams + 5) {
      return res.status(400).json({ 
        ok: false, 
        error: 'Too many path segments' 
      });
    }

    for (const segment of pathSegments) {
      if (segment.length > maxLength) {
        return res.status(400).json({ 
          ok: false, 
          error: 'Path segment too long' 
        });
      }
    }

    // Also strictly validate req.params in case this is applied as a route-specific middleware
    const keys = Object.keys(req.params || {});
    if (keys.length > maxParams) {
      return res.status(400).json({ 
        ok: false, 
        error: 'Too many path parameters' 
      });
    }

    for (const key of keys) {
      const value = req.params[key];
      if (typeof value === 'string' && value.length > maxLength) {
        return res.status(400).json({ 
          ok: false, 
          error: 'Path parameter too long' 
        });
      }
    }

    next();
  };
}