import { Request, Response, NextFunction, RequestHandler } from 'express';

export function limitPathParams(maxParams = 5, maxLength = 200): RequestHandler {
  // Uses RegExp only for validation, avoiding the vulnerable path-to-regexp matching
  const maxLengthRegex = new RegExp(`^.{0,${maxLength}}$`);

  return (req: Request, res: Response, next: NextFunction): void => {
    // 1. Validate by parsing populated req.params
    const params = req.params || {};
    const keys = Object.keys(params);

    if (keys.length > maxParams) {
      res.status(400).json({ error: 'Too many path parameters or parameter too long' });
      return;
    }

    for (const key of keys) {
      const val = params[key];
      if (val && !maxLengthRegex.test(val)) {
        res.status(400).json({ error: 'Too many path parameters or parameter too long' });
        return;
      }
    }

    // 2. Validate raw path segments directly. This ensures that when the middleware
    // is mounted globally via app.use() or router.use(), it catches oversized segments
    // before the vulnerable route matchers even run.
    const pathSegments = req.path.split('/');
    for (const segment of pathSegments) {
      if (!maxLengthRegex.test(segment)) {
        res.status(400).json({ error: 'Too many path parameters or parameter too long' });
        return;
      }
    }

    next();
  };
}