import { Request, Response, NextFunction, RequestHandler } from 'express';

export function limitPathParams(maxParams: number = 5, maxLength: number = 200): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    // 1. Direct validation of req.params (if already parsed by an Express router)
    const keys = Object.keys(req.params || {});
    if (keys.length > maxParams) {
      res.status(400).json({ ok: false, error: 'Too many path parameters or parameter too long' });
      return;
    }

    for (const key of keys) {
      if (typeof req.params[key] === 'string' && req.params[key].length > maxLength) {
        res.status(400).json({ ok: false, error: 'Too many path parameters or parameter too long' });
        return;
      }
    }

    // 2. Pre-emptive path validation using safe RegExp to prevent Express 
    // catastrophic backtracking before or during route matching.
    const path = req.path || '';
    const segments = path.match(/([^/]+)/g) || [];
    
    for (const segment of segments) {
      if (segment.length > maxLength) {
        res.status(400).json({ ok: false, error: 'Too many path parameters or parameter too long' });
        return;
      }
    }

    // Rough upper-bound heuristic to block ReDoS attempts via path nesting
    if (segments.length > maxParams * 2 + 5) {
      res.status(400).json({ ok: false, error: 'Too many path parameters or parameter too long' });
      return;
    }

    next();
  };
}