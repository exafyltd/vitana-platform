import { Request, Response, NextFunction, RequestHandler } from 'express';

export function limitPathParams(maxParams = 5, maxLength = 200): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    // 1. Raw path validation to prevent ReDoS before express route matching
    const segments = req.path.split('/');
    if (segments.length > maxParams + 10) {
      return res.status(400).json({ ok: false, error: 'Too many path parameters or parameter too long' });
    }
    for (const segment of segments) {
      if (segment.length > maxLength) {
        return res.status(400).json({ ok: false, error: 'Too many path parameters or parameter too long' });
      }
    }

    // 2. Parsed params validation as requested by the mitigation plan
    const keys = Object.keys(req.params || {});
    if (keys.length > maxParams) {
      return res.status(400).json({ ok: false, error: 'Too many path parameters or parameter too long' });
    }

    for (const key of keys) {
      if (req.params[key] && req.params[key].length > maxLength) {
        return res.status(400).json({ ok: false, error: 'Too many path parameters or parameter too long' });
      }
    }

    next();
  };
}