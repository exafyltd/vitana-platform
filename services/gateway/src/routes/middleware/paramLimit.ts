import { Request, Response, NextFunction, RequestHandler } from 'express';

export function limitPathParams(maxParams = 5, maxLength = 200): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.params) {
      next();
      return;
    }

    const keys = Object.keys(req.params);
    if (keys.length > maxParams) {
      res.status(400).json({
        ok: false,
        error: 'Too many path parameters'
      });
      return;
    }

    for (const key of keys) {
      const val = req.params[key];
      if (typeof val === 'string' && val.length > maxLength) {
        res.status(400).json({
          ok: false,
          error: 'Path parameter too long'
        });
        return;
      }
    }

    next();
  };
}