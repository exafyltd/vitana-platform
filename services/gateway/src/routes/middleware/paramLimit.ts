import { Request, Response, NextFunction, RequestHandler } from 'express';

export function limitPathParams(maxParams = 5, maxLength = 200): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const paramKeys = Object.keys(req.params || {});

    // Check maximum number of route parameters
    if (paramKeys.length > maxParams) {
      res.status(400).json({
        ok: false,
        error: 'Too many path parameters or parameter too long'
      });
      return;
    }

    // Check maximum length of any single parameter
    for (const key of paramKeys) {
      const val = req.params[key];
      if (typeof val === 'string' && val.length > maxLength) {
        res.status(400).json({
          ok: false,
          error: 'Too many path parameters or parameter too long'
        });
        return;
      }
    }

    next();
  };
}