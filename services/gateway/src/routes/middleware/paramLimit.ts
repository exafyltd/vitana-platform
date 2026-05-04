import { Request, Response, NextFunction, RequestHandler } from 'express';

export function limitPathParams(maxParams = 5, maxLength = 200): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    // 1. Raw segment check (effective for router.use() before route match)
    // Checking the raw path prevents regex evaluation from hanging entirely
    if (req.path) {
      const segments = req.path.split('/');
      for (const segment of segments) {
        if (segment.length > maxLength) {
          res.status(400).json({
            ok: false,
            error: 'Too many path parameters or parameter too long',
          });
          return;
        }
      }
    }

    // 2. Parsed params check (effective when applied to specific routes)
    const keys = Object.keys(req.params || {});
    if (keys.length > maxParams) {
      res.status(400).json({
        ok: false,
        error: 'Too many path parameters or parameter too long',
      });
      return;
    }

    for (const key of keys) {
      if (req.params[key] && req.params[key].length > maxLength) {
        res.status(400).json({
          ok: false,
          error: 'Too many path parameters or parameter too long',
        });
        return;
      }
    }

    next();
  };
}