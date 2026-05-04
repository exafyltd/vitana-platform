import { Request, Response, NextFunction, RequestHandler } from 'express';

export function limitPathParams(maxParams: number = 5, maxLength: number = 200): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    // 1. Path segment check to prevent ReDoS before route matching occurs.
    // We allow maxParams + 10 total segments to safely accommodate static base paths.
    const pathSegments = req.path.split('/').filter(Boolean);
    if (pathSegments.length > maxParams + 10) {
      return res.status(400).json({ ok: false, error: 'Too many path parameters or parameter too long' });
    }
    for (const segment of pathSegments) {
      if (segment.length > maxLength) {
        return res.status(400).json({ ok: false, error: 'Too many path parameters or parameter too long' });
      }
    }

    // 2. Parsed parameters check (if middleware runs after route matches or inline).
    const keys = Object.keys(req.params || {});
    if (keys.length > maxParams) {
      return res.status(400).json({ ok: false, error: 'Too many path parameters or parameter too long' });
    }
    for (const key of keys) {
      const val = req.params[key];
      if (val && val.length > maxLength) {
        return res.status(400).json({ ok: false, error: 'Too many path parameters or parameter too long' });
      }
    }

    next();
  };
}