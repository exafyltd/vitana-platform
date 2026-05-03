import { Request, Response, NextFunction, RequestHandler } from 'express';

export function limitPathParams(maxParams = 5, maxLength = 200): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    // 1. Strict compliance: Count keys in req.params
    const keys = Object.keys(req.params);
    
    if (keys.length > maxParams) {
      res.status(400).json({ error: 'Too many path parameters or parameter too long' });
      return;
    }

    // 2. Iterate values to check length
    for (const key of keys) {
      const value = req.params[key];
      if (value && typeof value === 'string' && value.length > maxLength) {
        res.status(400).json({ error: 'Too many path parameters or parameter too long' });
        return;
      }
    }

    // 3. Fallback: Uses RegExp only for validation
    // Validates the raw path to protect against ReDoS before route matching
    // if mounted globally or via router.use() where req.params may not be fully populated yet.
    const longSegmentRegex = new RegExp(`[^/]{${maxLength + 1},}`);
    if (longSegmentRegex.test(req.path)) {
      res.status(400).json({ error: 'Too many path parameters or parameter too long' });
      return;
    }

    next();
  };
}