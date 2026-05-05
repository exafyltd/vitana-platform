import { Request, Response, NextFunction, RequestHandler } from 'express';

export function limitPathParams(maxParams: number = 5, maxLength: number = 200): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    // 1. Validate raw path segments before Express route matching to prevent ReDoS
    const segments = req.path.split('/').filter(Boolean);
    
    // Allow static segments buffer (maxParams + 10 static segments should be enough for any valid API)
    if (segments.length > maxParams + 10) {
      return res.status(400).json({ ok: false, error: 'Too many path parameters or parameter too long' });
    }
    
    for (const segment of segments) {
      if (segment.length > maxLength) {
        return res.status(400).json({ ok: false, error: 'Too many path parameters or parameter too long' });
      }
    }

    // 2. Validate parsed req.params as explicitly defined
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