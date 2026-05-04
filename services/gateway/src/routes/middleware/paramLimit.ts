import { Request, Response, NextFunction, RequestHandler } from 'express';

export function limitPathParams(maxParams = 5, maxLength = 200): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    // 1. Check parsed params if already populated by prior middleware or route match
    if (req.params) {
      const keys = Object.keys(req.params);
      if (keys.length > maxParams) {
        res.status(400).json({ error: 'Too many path parameters or parameter too long' });
        return;
      }
      for (const key of keys) {
        const val = req.params[key];
        if (typeof val === 'string' && val.length > maxLength) {
          res.status(400).json({ error: 'Too many path parameters or parameter too long' });
          return;
        }
      }
    }

    // 2. Validate raw path to prevent ReDoS on subsequent route matching
    // Using RegExp-free string operations to avoid ReDoS in the mitigation itself
    if (req.path) {
      const segments = req.path.split('/');
      
      // Heuristic fallback for maxParams (add buffer for static segments in path)
      if (segments.length > maxParams + 10) {
        res.status(400).json({ error: 'Too many path parameters or parameter too long' });
        return;
      }
      
      for (const segment of segments) {
        if (segment.length > maxLength) {
          res.status(400).json({ error: 'Too many path parameters or parameter too long' });
          return;
        }
      }
    }

    next();
  };
}