import { Request, Response, NextFunction, RequestHandler } from 'express';

export function limitPathParams(maxParams = 5, maxLength = 200): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    // Isolate path from query string
    const pathOnly = (req.originalUrl || req.url || '').split('?')[0];

    // Validate the raw URL to prevent ReDoS before express router parsing.
    // We check for any segment exceeding maxLength.
    const longSegmentRegex = new RegExp(`/[^/]{${maxLength + 1},}`);
    if (longSegmentRegex.test(pathOnly)) {
      return res.status(400).json({ ok: false, error: 'Too many path parameters or parameter too long' });
    }

    // As a heuristic for ReDoS prevention at the router level, if the total number 
    // of segments in the path is extremely large, we can reject early.
    const segmentCount = pathOnly.split('/').filter(Boolean).length;
    if (segmentCount > maxParams + 10) {
      return res.status(400).json({ ok: false, error: 'Too many path parameters or parameter too long' });
    }

    // We also strictly validate req.params as specified by the plan.
    // Note: if middleware is mounted via router.use(), req.params may be empty here,
    // but we include this to satisfy exact plan requirements and per-route mountings.
    const keys = Object.keys(req.params || {});
    if (keys.length > maxParams) {
      return res.status(400).json({ ok: false, error: 'Too many path parameters or parameter too long' });
    }

    for (const key of keys) {
      const value = req.params[key];
      if (value && value.length > maxLength) {
        return res.status(400).json({ ok: false, error: 'Too many path parameters or parameter too long' });
      }
    }

    next();
  };
}