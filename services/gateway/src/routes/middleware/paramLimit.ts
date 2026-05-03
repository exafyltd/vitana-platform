import { Request, Response, NextFunction, RequestHandler } from 'express';

export function limitPathParams(maxParams = 5, maxLength = 200): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const keys = Object.keys(req.params || {});
    
    // 1. Verify the number of parsed parameters
    if (keys.length > maxParams) {
      res.status(400).json({ error: 'Too many path parameters or parameter too long' });
      return;
    }

    // 2. Verify the length of each matched parameter
    for (const key of keys) {
      const val = req.params[key];
      if (val && typeof val === 'string' && val.length > maxLength) {
        res.status(400).json({ error: 'Too many path parameters or parameter too long' });
        return;
      }
    }

    // 3. Additional raw path validation to prevent ReDoS matching before params are mapped.
    // Express runs route matching before passing req.params to route-level middleware.
    // Checking req.path ensures pathological URLs are rejected early using fast string ops.
    const segments = req.path.split('/');
    for (const segment of segments) {
      if (segment.length > maxLength) {
        res.status(400).json({ error: 'Too many path parameters or parameter too long' });
        return;
      }
    }

    next();
  };
}