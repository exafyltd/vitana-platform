import { Request, Response, NextFunction, RequestHandler } from 'express';

export function limitPathParams(maxParams = 5, maxLength = 200): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    // 1. Check req.path segments for maxLength to protect against ReDoS
    // during route matching (before req.params is populated).
    // Using RegExp for validation as specified in the plan.
    const segmentRegex = new RegExp(`^[^/]{0,${maxLength}}$`);
    const segments = req.path.split('/').filter(Boolean);
    
    for (const segment of segments) {
      if (!segmentRegex.test(segment)) {
        res.status(400).json({ ok: false, error: 'Too many path parameters or parameter too long' });
        return;
      }
    }

    // 2. Check req.params to enforce route-parameter boundaries if already matched
    const keys = Object.keys(req.params || {});
    if (keys.length > maxParams) {
      res.status(400).json({ ok: false, error: 'Too many path parameters or parameter too long' });
      return;
    }

    for (const key of keys) {
      if (req.params[key] && req.params[key].length > maxLength) {
        res.status(400).json({ ok: false, error: 'Too many path parameters or parameter too long' });
        return;
      }
    }

    next();
  };
}