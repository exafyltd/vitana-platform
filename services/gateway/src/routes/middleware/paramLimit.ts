import { Request, Response, NextFunction, RequestHandler } from 'express';

export function limitPathParams(maxParams = 5, maxLength = 200): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    // 1. Validate already parsed req.params (e.g., if mounted as route-specific middleware)
    const keys = Object.keys(req.params);
    if (keys.length > maxParams) {
      res.status(400).json({ ok: false, error: 'Too many path parameters' });
      return;
    }

    for (const key of keys) {
      const val = req.params[key];
      if (val && val.length > maxLength) {
        res.status(400).json({ ok: false, error: 'Path parameter too long' });
        return;
      }
    }

    // 2. Validate raw path segments to prevent ReDoS before route matching occurs.
    // Express route matching is vulnerable to catastrophic backtracking with long segments.
    // Checking req.path catches malicious payloads before they hit vulnerable path-to-regexp matching.
    const segments = req.path.split('/').filter(Boolean);
    
    // Enforce max length on any raw segment to stop the ReDoS backtrack explosion.
    for (const segment of segments) {
      if (segment.length > maxLength) {
        res.status(400).json({ ok: false, error: 'Path parameter too long' });
        return;
      }
    }

    // Prevent excessive segments overall to stop exponential backtracking complexity.
    // We use a safe padding relative to maxParams to account for static path prefixes.
    const maxTotalSegments = maxParams + 10; 
    if (segments.length > maxTotalSegments) {
      res.status(400).json({ ok: false, error: 'Too many path parameters' });
      return;
    }

    next();
  };
}