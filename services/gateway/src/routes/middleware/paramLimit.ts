import { Request, Response, NextFunction, RequestHandler } from 'express';

/**
 * Middleware to mitigate ReDoS vulnerabilities in path-to-regexp.
 * It limits the number of path parameters/segments and the maximum length of any segment.
 */
export function limitPathParams(maxParams: number = 5, maxLength: number = 200): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    // 1. Defend against ReDoS before Express route matching by checking raw path segments.
    // This provides coverage even when the middleware is mounted via router.use() globally.
    if (req.path) {
      const segments = req.path.split('/').filter(Boolean);
      // We allow base path segments by adding an arbitrary safe buffer (10)
      if (segments.length > maxParams + 10) {
        return res.status(400).json({ 
          ok: false, 
          error: 'Too many path segments or parameters' 
        });
      }
      for (const segment of segments) {
        if (segment.length > maxLength) {
          return res.status(400).json({ 
            ok: false, 
            error: 'Path parameter or segment too long' 
          });
        }
      }
    }

    // 2. Validate parsed req.params per the spec, supporting specific route-level middleware bounds.
    if (req.params) {
      const keys = Object.keys(req.params);
      if (keys.length > maxParams) {
        return res.status(400).json({ 
          ok: false, 
          error: 'Too many path parameters' 
        });
      }
      for (const key of keys) {
        const value = req.params[key];
        if (value && String(value).length > maxLength) {
          return res.status(400).json({ 
            ok: false, 
            error: 'Path parameter too long' 
          });
        }
      }
    }

    next();
  };
}