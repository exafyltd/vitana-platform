import { Request, Response, NextFunction, RequestHandler } from 'express';

export function limitPathParams(maxParams: number = 5, maxLength: number = 200): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    // 1. Validate parsed req.params (if middleware is applied after route match)
    const params = req.params || {};
    const keys = Object.keys(params);

    if (keys.length > maxParams) {
      res.status(400).json({ error: 'Too many path parameters or parameter too long' });
      return;
    }

    for (const key of keys) {
      const val = params[key];
      if (val && val.length > maxLength) {
        res.status(400).json({ error: 'Too many path parameters or parameter too long' });
        return;
      }
    }

    // 2. Validate req.path via RegExp to mitigate ReDoS *before* Express matches routes
    // (Crucial for when middleware is applied globally via router.use())
    const pathSegments = req.path.match(/[^/]+/g) || [];
    for (const segment of pathSegments) {
      if (segment.length > maxLength) {
        res.status(400).json({ error: 'Too many path parameters or parameter too long' });
        return;
      }
    }

    next();
  };
}