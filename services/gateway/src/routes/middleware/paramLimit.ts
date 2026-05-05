import { Request, Response, NextFunction, RequestHandler } from 'express';

export function limitPathParams(maxParams: number = 5, maxLength: number = 200): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const errorMsg = 'Too many path parameters or parameter too long';

    // 1. Raw path validation to catch ReDoS before route matching
    const longSegmentRegex = new RegExp(`[^/]{${maxLength + 1},}`);
    if (longSegmentRegex.test(req.path)) {
      return res.status(400).json({ ok: false, error: errorMsg });
    }

    const segmentCount = (req.path.match(/\//g) || []).length;
    // Heuristic: If segments > maxParams * 3, it is suspiciously deep.
    if (segmentCount > maxParams * 3) {
      return res.status(400).json({ ok: false, error: errorMsg });
    }

    // 2. Parsed req.params validation (enforces limit post-matching or route-level)
    if (req.params) {
      const keys = Object.keys(req.params);
      if (keys.length > maxParams) {
        return res.status(400).json({ ok: false, error: errorMsg });
      }
      for (const key of keys) {
        const val = req.params[key];
        if (typeof val === 'string' && val.length > maxLength) {
          return res.status(400).json({ ok: false, error: errorMsg });
        }
      }
    }

    next();
  };
}