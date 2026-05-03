import { Request, Response, NextFunction, RequestHandler } from 'express';

export function limitPathParams(maxParams = 5, maxLength = 200): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    // 1. Validate parsed req.params if they are already populated
    if (req.params) {
      const keys = Object.keys(req.params);
      if (keys.length > maxParams) {
        res.status(400).json({ error: 'Too many path parameters or parameter too long' });
        return;
      }

      for (const key of keys) {
        const val = req.params[key];
        if (val && String(val).length > maxLength) {
          res.status(400).json({ error: 'Too many path parameters or parameter too long' });
          return;
        }
      }
    }
    
    // 2. Use RegExp only for raw validation avoiding path-to-regexp matching.
    // This is a safety mechanism when the middleware is run before route parameter extraction.
    if (req.path) {
      const excessivelyLongSegment = new RegExp(`[^/]{${maxLength + 1},}`);
      if (excessivelyLongSegment.test(req.path)) {
        res.status(400).json({ error: 'Too many path parameters or parameter too long' });
        return;
      }
    }

    next();
  };
}