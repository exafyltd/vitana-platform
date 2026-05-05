import { Request, Response, NextFunction, RequestHandler } from 'express';

export function limitPathParams(maxParams: number = 5, maxLength: number = 200): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    // 1. Validate route parameters extracted by Express (if applied directly at the route level)
    const keys = Object.keys(req.params || {});

    if (keys.length > maxParams) {
      return res.status(400).json({
        ok: false,
        error: 'Too many path parameters or parameter too long'
      });
    }

    for (const key of keys) {
      if (req.params[key] && req.params[key].length > maxLength) {
        return res.status(400).json({
          ok: false,
          error: 'Too many path parameters or parameter too long'
        });
      }
    }

    // 2. Validate raw path segments as an early safeguard
    // This pre-emptively intercepts malicious paths before they hit vulnerable Express route matching
    const segments = req.path.split('/').filter(Boolean);

    for (const segment of segments) {
      if (segment.length > maxLength) {
        return res.status(400).json({
          ok: false,
          error: 'Too many path parameters or parameter too long'
        });
      }
    }

    next();
  };
}