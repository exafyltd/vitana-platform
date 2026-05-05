import { Request, Response, NextFunction, RequestHandler } from 'express';

export function limitPathParams(maxParams: number = 5, maxLength: number = 200): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const paramKeys = Object.keys(req.params || {});

    // Check maximum number of path parameters
    if (paramKeys.length > maxParams) {
      res.status(400).json({
        ok: false,
        error: 'Too many path parameters or parameter too long'
      });
      return;
    }

    // Check maximum length of each path parameter
    for (const key of paramKeys) {
      const value = req.params[key];
      if (value && typeof value === 'string' && value.length > maxLength) {
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