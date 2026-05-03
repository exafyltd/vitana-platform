import { Request, Response, NextFunction, RequestHandler } from 'express';

export function limitPathParams(maxParams = 5, maxLength = 200): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.params) {
      // Filter out undefined parameters (e.g., unmatched optional params)
      const providedKeys = Object.keys(req.params).filter(
        (key) => req.params[key] !== undefined
      );

      if (providedKeys.length > maxParams) {
        res.status(400).json({ error: 'Too many path parameters or parameter too long' });
        return;
      }

      for (const key of providedKeys) {
        const paramValue = req.params[key];
        if (typeof paramValue === 'string' && paramValue.length > maxLength) {
          res.status(400).json({ error: 'Too many path parameters or parameter too long' });
          return;
        }
      }
    }

    next();
  };
}