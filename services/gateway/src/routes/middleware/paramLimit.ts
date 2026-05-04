import { Request, Response, NextFunction, RequestHandler } from 'express';

export function limitPathParams(maxParams: number = 5, maxLength: number = 200): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    // 1. Validate route parameters if they are already populated
    const params = req.params || {};
    const keys = Object.keys(params);

    if (keys.length > maxParams) {
      res.status(400).json({ error: 'Too many path parameters or parameter too long' });
      return;
    }

    for (const key of keys) {
      if (params[key] && params[key].length > maxLength) {
        res.status(400).json({ error: 'Too many path parameters or parameter too long' });
        return;
      }
    }

    // 2. Uses RegExp only for validation of the raw path, avoiding the vulnerable 
    // path-to-regexp matching. This provides protection even when applied globally via router.use()
    const path = req.path || '';

    // Reject if any path segment exceeds maxLength
    const longSegmentRegex = new RegExp(`[^/]{${maxLength + 1},}`);
    if (longSegmentRegex.test(path)) {
      res.status(400).json({ error: 'Too many path parameters or parameter too long' });
      return;
    }

    // Reject if there are an excessive number of path segments (ReDoS heuristic)
    // We allow up to maxParams + a baseline of 5 static segments
    const maxSegments = maxParams + 5;
    const segmentCount = (path.match(/\//g) || []).length;
    if (segmentCount > maxSegments) {
      res.status(400).json({ error: 'Too many path parameters or parameter too long' });
      return;
    }

    next();
  };
}