import { Request, Response, NextFunction, RequestHandler } from 'express';

export function limitPathParams(maxParams = 5, maxLength = 200): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    // 1. Validate based on Express req.params (for when middleware runs inline/post-matching)
    const keys = Object.keys(req.params || {});
    
    if (keys.length > maxParams) {
      res.status(400).json({ error: 'Too many path parameters or parameter too long' });
      return;
    }

    for (const key of keys) {
      const value = req.params[key];
      if (typeof value === 'string' && value.length > maxLength) {
        res.status(400).json({ error: 'Too many path parameters or parameter too long' });
        return;
      }
    }

    // 2. Validate raw path to protect against ReDoS before route matching occurs.
    // Uses RegExp only for safe extraction, avoiding vulnerable path-to-regexp backtracking.
    const rawPath = req.path || '';
    const segmentRegex = /[^/]+/g;
    let match;
    let segmentCount = 0;

    while ((match = segmentRegex.exec(rawPath)) !== null) {
      segmentCount++;
      if (match[0].length > maxLength) {
        res.status(400).json({ error: 'Too many path parameters or parameter too long' });
        return;
      }
    }

    // Allow some extra segments for static base paths (e.g., /api/v1/resource)
    if (segmentCount > maxParams + 5) {
      res.status(400).json({ error: 'Too many path parameters or parameter too long' });
      return;
    }

    next();
  };
}