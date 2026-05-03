import { Request, Response, NextFunction, RequestHandler } from 'express';

export function limitPathParams(maxParams = 5, maxLength = 200): RequestHandler {
  // Use RegExp only for validation, avoiding the vulnerable path-to-regexp matching.
  // This regex matches any single path segment that exceeds maxLength.
  const longSegmentRegex = new RegExp(`[^/]{${maxLength + 1},}`);

  return (req: Request, res: Response, next: NextFunction) => {
    // 1. Validate raw path to defend against ReDoS before Express path-to-regexp
    // executes. This is crucial for when the middleware is applied via router.use()
    const pathString = req.path || '';
    if (longSegmentRegex.test(pathString)) {
      res.status(400).json({ error: 'Too many path parameters or parameter too long' });
      return;
    }

    // 2. Parse req.params and count keys as an explicit post-match defense layer
    const params = req.params || {};
    const keys = Object.keys(params);

    if (keys.length > maxParams) {
      res.status(400).json({ error: 'Too many path parameters or parameter too long' });
      return;
    }

    for (const key of keys) {
      const val = params[key];
      if (typeof val === 'string' && val.length > maxLength) {
        res.status(400).json({ error: 'Too many path parameters or parameter too long' });
        return;
      }
    }

    next();
  };
}