import { Request, Response, NextFunction, RequestHandler } from 'express';

export function limitPathParams(maxParams: number = 5, maxLength: number = 200): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const pathStr = req.path || '';
    
    // 1. Raw path validation (defense-in-depth before Express populates req.params)
    // Avoids catastrophic backtracking in path-to-regexp by catching long segments early
    // using a simple, non-vulnerable RegExp.
    const segmentLengthRegex = new RegExp(`[^/]{${maxLength + 1},}`);
    if (segmentLengthRegex.test(pathStr)) {
      res.status(400).json({ error: 'Too many path parameters or parameter too long' });
      return;
    }

    // Prevent paths with an excessive number of segments overall to avoid ReDoS
    const segments = pathStr.split('/');
    if (segments.length > maxParams + 10) { // +10 allowance for static route segments
      res.status(400).json({ error: 'Too many path parameters or parameter too long' });
      return;
    }

    // 2. Parsed parameters validation
    // Enforces exact limits on the path parameters once parsed by the router
    const paramKeys = Object.keys(req.params || {});
    if (paramKeys.length > maxParams) {
      res.status(400).json({ error: 'Too many path parameters or parameter too long' });
      return;
    }

    for (const key of paramKeys) {
      const val = req.params[key];
      if (val && typeof val === 'string' && val.length > maxLength) {
        res.status(400).json({ error: 'Too many path parameters or parameter too long' });
        return;
      }
    }

    next();
  };
}