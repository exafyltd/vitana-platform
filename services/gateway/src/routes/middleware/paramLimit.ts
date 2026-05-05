import { Request, Response, NextFunction } from 'express';

export function limitPathParams(maxParams = 5, maxLength = 200) {
  return (req: Request, res: Response, next: NextFunction) => {
    // Validate raw path segments to protect against ReDoS before route matching
    const segments = req.path.split('/');
    for (const segment of segments) {
      if (segment.length > maxLength) {
        return res.status(400).json({ ok: false, error: 'Path parameter too long' });
      }
    }

    // Validate req.params if available (e.g., when applied at the route level)
    const keys = Object.keys(req.params || {});
    if (keys.length > maxParams) {
      return res.status(400).json({ ok: false, error: 'Too many path parameters' });
    }

    for (const key of keys) {
      const val = req.params[key];
      if (val && val.length > maxLength) {
        return res.status(400).json({ ok: false, error: 'Path parameter too long' });
      }
    }

    next();
  };
}