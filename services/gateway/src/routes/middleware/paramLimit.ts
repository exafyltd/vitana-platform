import { Request, Response, NextFunction, RequestHandler } from 'express';

export function limitPathParams(maxParams = 5, maxLength = 200): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const keys = Object.keys(req.params);

    if (keys.length > maxParams) {
      res.status(400).json({ 
        ok: false, 
        error: 'Too many path parameters' 
      });
      return;
    }

    for (const key of keys) {
      const value = req.params[key];
      if (value && value.length > maxLength) {
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