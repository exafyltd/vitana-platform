import { Request, Response, NextFunction, RequestHandler } from 'express';

export function limitPathParams(maxParams = 5, maxLength = 200): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const params = req.params || {};
    const keys = Object.keys(params);

    if (keys.length > maxParams) {
      return res.status(400).json({
        ok: false,
        error: 'Too many path parameters or parameter too long'
      });
    }

    for (const key of keys) {
      const value = params[key];
      if (typeof value === 'string' && value.length > maxLength) {
        return res.status(400).json({
          ok: false,
          error: 'Too many path parameters or parameter too long'
        });
      }
    }

    next();
  };
}