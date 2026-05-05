import { Request, Response, NextFunction, RequestHandler } from 'express';

export function limitPathParams(maxParams = 5, maxLength = 200): RequestHandler {
  // A fast regex to prevent long strings from causing processing delays later; 
  // matches any single path segment that exceeds maxLength bounds.
  const longSegmentRegex = new RegExp(`/[^/]{${maxLength + 1},}`);

  return (req: Request, res: Response, next: NextFunction) => {
    // 1. Raw path validation. This protects against ReDoS even if mounted 
    // globally via app.use() or router.use() prior to route match.
    if (longSegmentRegex.test(req.path)) {
      res.status(400).json({ ok: false, error: 'Too many path parameters or parameter too long' });
      return;
    }

    // 2. Parsed parameters validation (triggers when applied specifically to a route)
    const keys = Object.keys(req.params);
    if (keys.length > maxParams) {
      res.status(400).json({ ok: false, error: 'Too many path parameters or parameter too long' });
      return;
    }

    for (const key of keys) {
      const value = req.params[key];
      if (value && value.length > maxLength) {
        res.status(400).json({ ok: false, error: 'Too many path parameters or parameter too long' });
        return;
      }
    }

    next();
  };
}